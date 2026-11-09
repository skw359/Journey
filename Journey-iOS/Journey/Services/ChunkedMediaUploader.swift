// Resumable chunked video upload to the server.

import Foundation
import CryptoKit

nonisolated struct ChunkedUploadJob: Codable, Sendable, Identifiable, Equatable {
    let id: UUID
    let journeyID: String
    let localName: String
    let serverName: String
    let mimeType: String
    let size: Int64
    let key: String
    let account: String
    var serverUploadID: String?
}

nonisolated enum ChunkedUploadError: LocalizedError, Equatable {
    case interrupted
    case insufficientStorage
    case sourceChanged
    case server(status: Int, message: String?)

    var errorDescription: String? {
        switch self {
        case .interrupted:
            "The upload was interrupted. Choose the video again to continue from where it stopped."
        case .insufficientStorage:
            "There isn't enough free space on this device to upload the video."
        case .sourceChanged:
            "The video couldn't be read. Please choose it again."
        case .server(let status, let message):
            message ?? "The server couldn't take the video (error \(status))."
        }
    }

    static func isOutOfSpace(_ error: Error) -> Bool {
        var current: NSError? = error as NSError
        while let nsError = current {
            if nsError.domain == NSCocoaErrorDomain, nsError.code == NSFileWriteOutOfSpaceError { return true }
            if nsError.domain == NSPOSIXErrorDomain, nsError.code == Int(ENOSPC) { return true }
            current = nsError.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return false
    }
}

nonisolated enum ChunkFile {
    static let bufferBytes = 1 << 20

    static func size(of url: URL) throws -> Int64 {
        var info = stat()
        guard stat(url.path, &info) == 0 else { throw posixError() }
        return Int64(info.st_size)
    }

    static func copySlice(of source: URL, offset: Int64, length: Int64, to destination: URL) throws {
        let input = open(source.path, O_RDONLY)
        guard input >= 0 else { throw posixError() }
        defer { close(input) }
        let output = open(destination.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard output >= 0 else { throw posixError() }
        defer { close(output) }

        let buffer = UnsafeMutableRawPointer.allocate(byteCount: bufferBytes, alignment: 16)
        defer { buffer.deallocate() }
        var position = offset
        var remaining = length
        while remaining > 0 {
            let count = pread(input, buffer, Int(min(remaining, Int64(bufferBytes))), position)
            if count < 0 {
                if errno == EINTR { continue }
                throw posixError()
            }
            if count == 0 { throw ChunkedUploadError.sourceChanged }
            var written = 0
            while written < count {
                let wrote = write(output, buffer + written, count - written)
                if wrote < 0 {
                    if errno == EINTR { continue }
                    throw posixError()
                }
                written += wrote
            }
            position += Int64(count)
            remaining -= Int64(count)
        }
    }

    static func fingerprint(of url: URL) throws -> String {
        let input = open(url.path, O_RDONLY)
        guard input >= 0 else { throw posixError() }
        defer { close(input) }
        let size = try size(of: url)
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: bufferBytes, alignment: 16)
        defer { buffer.deallocate() }

        var hash = SHA256()
        for start in [0, max(0, size - Int64(bufferBytes))] {
            let count = pread(input, buffer, bufferBytes, start)
            guard count >= 0 else { throw posixError() }
            hash.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: count))
        }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        return "ios:\(size):\(digest)"
    }

    static func digest(of text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func posixError() -> Error {
        let code = errno
        if code == ENOSPC { return ChunkedUploadError.insufficientStorage }
        if code == ENOENT { return ChunkedUploadError.sourceChanged }
        return POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
    }
}

nonisolated protocol ChunkedUploadTransport: Sendable {
    func send(
        _ request: URLRequest,
        bodyFile: URL?,
        onBytesSent: @escaping @Sendable (Int64) -> Void
    ) async throws -> (data: Data, status: Int)
}

nonisolated struct ChunkedMediaUploader: Sendable {
    static let defaultChunkBytes: Int64 = 32 << 20

    typealias RequestBuilder = @Sendable (_ path: String, _ method: String) async throws -> URLRequest

    private static let retryableStatuses: Set<Int> = [408, 429, 500, 502, 503, 504]

    let transport: any ChunkedUploadTransport
    let makeRequest: RequestBuilder
    var chunkBytes = defaultChunkBytes
    var maxFailures = 8
    var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }

    private enum Phase {
        case start
        case sync
        case send
    }

    @concurrent
    func upload(
        _ job: ChunkedUploadJob,
        file: URL,
        scratch: URL,
        onUploadID: @escaping @Sendable (String?) async -> Void,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> Data {
        guard try ChunkFile.size(of: file) == job.size else { throw ChunkedUploadError.sourceChanged }
        defer { try? FileManager.default.removeItem(at: scratch) }

        let base = "/api/routes/\(job.journeyID)/uploads"
        let meter = UploadProgressMeter(total: job.size, onProgress: onProgress)
        var uploadID = job.serverUploadID
        var offset: Int64 = 0
        var phase: Phase = uploadID == nil ? .start : .sync
        var failures = 0
        var restarted = false
        var scratchRange: Range<Int64>?

        while true {
            try Task.checkCancellation()
            var retry: ChunkedUploadError?

            do {
                switch phase {
                case .start:
                    let response = try await startUpload(job, path: base)
                    if Self.isOK(response.status) {
                        let body = Self.json(response.data)
                        guard let id = body["id"] as? String else {
                            throw ChunkedUploadError.server(status: response.status, message: nil)
                        }
                        uploadID = id
                        offset = Self.int64(body["offset"]) ?? 0
                        await onUploadID(id)
                        meter.reset(to: offset)
                        phase = .send
                    } else if Self.retryableStatuses.contains(response.status) {
                        retry = Self.rejection(response)
                    } else {
                        throw Self.rejection(response)
                    }

                case .sync:
                    let request = try await makeRequest("\(base)/\(uploadID ?? "")", "GET")
                    let response = try await transport.send(request, bodyFile: nil) { _ in }
                    if Self.isOK(response.status) {
                        let body = Self.json(response.data)
                        if body["photos"] != nil { return response.data }
                        let received = Self.int64(body["offset"]) ?? offset
                        if received > offset { failures = 0 }
                        offset = received
                        meter.update(sent: offset)
                        phase = .send
                    } else if response.status == 404 {
                        guard !restarted else { throw Self.rejection(response) }
                        restarted = true
                        uploadID = nil
                        await onUploadID(nil)
                        phase = .start
                    } else if Self.retryableStatuses.contains(response.status) {
                        retry = Self.rejection(response)
                    } else {
                        throw Self.rejection(response)
                    }

                case .send:
                    let length = min(chunkBytes, job.size - offset)
                    let range = offset..<(offset + length)
                    if length > 0, scratchRange != range {
                        scratchRange = nil
                        try ChunkFile.copySlice(of: file, offset: offset, length: length, to: scratch)
                        scratchRange = range
                    }
                    var request = try await makeRequest("\(base)/\(uploadID ?? "")?offset=\(offset)", "PUT")
                    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                    if length == 0 { request.httpBody = Data() }

                    let from = offset
                    let response = try await transport.send(request, bodyFile: length > 0 ? scratch : nil) { sent in
                        meter.update(sent: from + sent)
                    }
                    if Self.isOK(response.status) {
                        let body = Self.json(response.data)
                        if body["photos"] != nil {
                            meter.update(sent: job.size)
                            return response.data
                        }
                        let received = Self.int64(body["offset"]) ?? (offset + length)
                        if received > offset { failures = 0 }
                        offset = received
                        meter.update(sent: offset)
                    } else if response.status == 404 {
                        guard !restarted else { throw Self.rejection(response) }
                        restarted = true
                        uploadID = nil
                        await onUploadID(nil)
                        phase = .start
                    } else if response.status == 409 || Self.retryableStatuses.contains(response.status) {
                        retry = Self.rejection(response)
                    } else {
                        throw Self.rejection(response)
                    }
                }
            } catch let error as URLError {
                if Task.isCancelled || error.code == .cancelled { throw CancellationError() }
                guard Self.isTransient(error) else { throw error }
                retry = .interrupted
            }

            if let retry {
                failures += 1
                guard failures <= maxFailures else {
                    if case .server(_, .some) = retry { throw retry }
                    throw ChunkedUploadError.interrupted
                }
                try await sleep(.seconds(min(1 << min(failures - 1, 5), 30)))
                phase = uploadID == nil ? .start : .sync
            }
        }
    }

    private func startUpload(_ job: ChunkedUploadJob, path: String) async throws -> (data: Data, status: Int) {
        var request = try await makeRequest(path, "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "name": job.serverName,
            "size": job.size,
            "type": job.mimeType,
            "key": job.key
        ] as [String: Any])
        return try await transport.send(request, bodyFile: nil) { _ in }
    }

    private static func isOK(_ status: Int) -> Bool { (200..<300).contains(status) }

    private static func isTransient(_ error: URLError) -> Bool {
        switch error.code {
        case .badURL, .unsupportedURL, .appTransportSecurityRequiresSecureConnection,
             .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired,
             .userAuthenticationRequired, .userCancelledAuthentication, .fileDoesNotExist:
            false
        default:
            true
        }
    }

    private static func json(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private static func int64(_ value: Any?) -> Int64? {
        (value as? NSNumber)?.int64Value
    }

    private static func rejection(_ response: (data: Data, status: Int)) -> ChunkedUploadError {
        .server(status: response.status, message: json(response.data)["error"] as? String)
    }
}

nonisolated final class UploadProgressMeter: @unchecked Sendable {
    private let total: Int64
    private let onProgress: @Sendable (Double) -> Void
    private let lock = NSLock()
    private var reported = -1.0

    init(total: Int64, onProgress: @escaping @Sendable (Double) -> Void) {
        self.total = total
        self.onProgress = onProgress
    }

    func reset(to sent: Int64) {
        lock.withLock { reported = -1 }
        update(sent: sent)
    }

    func update(sent: Int64) {
        guard total > 0 else { return }
        let fraction = min(Double(sent) / Double(total), 1)
        let shouldReport = lock.withLock {
            guard fraction >= reported + 0.01 || (fraction == 1 && reported < 1) else { return false }
            reported = fraction
            return true
        }
        if shouldReport { onProgress(fraction) }
    }
}

nonisolated final class URLSessionChunkTransport: ChunkedUploadTransport {
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
    }

    func send(
        _ request: URLRequest,
        bodyFile: URL?,
        onBytesSent: @escaping @Sendable (Int64) -> Void
    ) async throws -> (data: Data, status: Int) {
        let result: (Data, URLResponse)
        if let bodyFile {
            let delegate = ChunkProgressDelegate(onBytesSent: onBytesSent)
            result = try await session.upload(for: request, fromFile: bodyFile, delegate: delegate)
        } else {
            result = try await session.data(for: request)
        }
        return (result.0, (result.1 as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

nonisolated private final class ChunkProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let onBytesSent: @Sendable (Int64) -> Void

    init(onBytesSent: @escaping @Sendable (Int64) -> Void) {
        self.onBytesSent = onBytesSent
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        onBytesSent(totalBytesSent)
    }
}
