import Foundation
import Darwin
@testable import Journey

/// The rules of `server/routes/mediaUploads.js`, in memory, with ways to make things go wrong.
/// Stores a running SHA-free copy of what it receives only when asked, so tests of huge files
/// don't themselves use up the memory they're measuring.
final class FakeUploadServer: ChunkedUploadTransport, @unchecked Sendable {
    enum Fault {
        /// The connection drops after the server has stored this many bytes of the piece.
        case dropAfter(Int64)
        /// The server stores the piece, but the response never arrives.
        case loseResponse
        case status(Int, String? = nil)
        case urlError(URLError.Code)
    }

    struct Logged {
        let method: String
        let path: String
        let contentType: String?
        let bodyBytes: Int64
    }

    private let lock = NSLock()
    private let keepBytes: Bool
    private var uploads: [String: (size: Int64, key: String?, received: Int64, finished: Bool)] = [:]
    private var faults: [String: [Fault]] = [:]
    private var nextID = 1

    private(set) var stored = Data()
    private(set) var log: [Logged] = []
    private(set) var finishCount = 0
    private(set) var peakFootprint: UInt64 = 0
    private var onPiece: (@Sendable () -> Void)?

    init(keepBytes: Bool = true) {
        self.keepBytes = keepBytes
    }

    /// The next request with this method fails this way; several queue up in order.
    func inject(_ fault: Fault, on method: String) {
        lock.withLock { faults[method, default: []].append(fault) }
    }

    func forgetUploads() {
        lock.withLock { uploads = [:] }
    }

    /// Stores all but the end of an upload that's been started, as if it arrived earlier.
    func seed(id: String, size: Int64, received: Int64, key: String) {
        lock.withLock { uploads[id] = (size, key, received, false) }
    }

    func setOnPiece(_ handler: @escaping @Sendable () -> Void) {
        lock.withLock { onPiece = handler }
    }

    var received: Int64 {
        lock.withLock { uploads.values.first?.received ?? 0 }
    }

    var requests: [Logged] { lock.withLock { log } }

    func send(
        _ request: URLRequest,
        bodyFile: URL?,
        onBytesSent: @escaping @Sendable (Int64) -> Void
    ) async throws -> (data: Data, status: Int) {
        try Task.checkCancellation()
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let bodySize = try bodyFile.map { try ChunkFile.size(of: $0) } ?? 0
        let (fault, callback): (Fault?, (@Sendable () -> Void)?) = lock.withLock {
            log.append(Logged(method: method, path: path, contentType: request.value(forHTTPHeaderField: "Content-Type"), bodyBytes: bodySize))
            peakFootprint = max(peakFootprint, Self.footprint())
            let next = faults[method]?.isEmpty == false ? faults[method]?.removeFirst() : nil
            return (next, method == "PUT" ? onPiece : nil)
        }
        callback?()
        try Task.checkCancellation()

        switch fault {
        case .status(let code, let message):
            return (Self.body(["error": message ?? "Failure \(code)"]), code)
        case .urlError(let code):
            throw URLError(code)
        default:
            break
        }

        switch method {
        case "POST":
            return try start(request)
        case "GET":
            let id = request.url?.lastPathComponent ?? ""
            return lock.withLock { progressResponse(id) }
        case "PUT":
            return try put(request, bodyFile: bodyFile, bodySize: bodySize, fault: fault, onBytesSent: onBytesSent)
        default:
            return (Data(), 405)
        }
    }

    private func start(_ request: URLRequest) throws -> (data: Data, status: Int) {
        let json = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any] ?? [:]
        let size = (json["size"] as? NSNumber)?.int64Value ?? 0
        let key = json["key"] as? String
        return lock.withLock {
            if let found = uploads.first(where: { $0.value.key == key && $0.value.size == size && !$0.value.finished }) {
                return (Self.body(["id": found.key, "size": size, "offset": found.value.received]), 200)
            }
            let id = "upload-\(nextID)"
            nextID += 1
            uploads[id] = (size, key, 0, false)
            stored = Data()
            return (Self.body(["id": id, "size": size, "offset": 0]), 201)
        }
    }

    private func put(
        _ request: URLRequest,
        bodyFile: URL?,
        bodySize: Int64,
        fault: Fault?,
        onBytesSent: @escaping @Sendable (Int64) -> Void
    ) throws -> (data: Data, status: Int) {
        let id = request.url?.lastPathComponent ?? ""
        let offset = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "offset" }?.value.flatMap(Int64.init) ?? -1

        let check: (data: Data, status: Int)? = lock.withLock {
            guard let upload = uploads[id] else { return (Self.body(["error": "Upload not found; start it again"]), 404) }
            if upload.finished { return offset == upload.size ? progressResponse(id) : (Self.body(["error": "complete"]), 409) }
            if offset != upload.received { return (Self.body(["error": "offset mismatch", "offset": upload.received]), 409) }
            return nil
        }
        if let check { return check }

        var accepted = bodySize
        if case .dropAfter(let bytes) = fault { accepted = min(bytes, bodySize) }
        if keepBytes, let bodyFile, accepted > 0 {
            let piece = try Data(contentsOf: bodyFile).prefix(Int(accepted))
            lock.withLock { stored.append(piece) }
        }
        onBytesSent(accepted)
        lock.withLock {
            uploads[id]?.received += accepted
            if let upload = uploads[id], upload.received >= upload.size {
                uploads[id]?.finished = true
                finishCount += 1
            }
        }
        if case .dropAfter = fault { throw URLError(.networkConnectionLost) }
        if case .loseResponse = fault { throw URLError(.networkConnectionLost) }
        return lock.withLock { progressResponse(id) }
    }

    private func progressResponse(_ id: String) -> (data: Data, status: Int) {
        guard let upload = uploads[id] else { return (Self.body(["error": "Upload not found; start it again"]), 404) }
        if upload.finished {
            return (Self.body(["id": id, "size": upload.size, "offset": upload.size, "photos": [["id": "video-1", "kind": "video", "status": "processing"]], "skipped": []]), 200)
        }
        return (Self.body(["id": id, "size": upload.size, "offset": upload.received]), 200)
    }

    private static func body(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }
}

/// A temporary folder with a file of random bytes, or a sparse one that takes no disk.
final class TestFiles {
    let directory: URL

    init() throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "journey-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: directory)
    }

    func random(_ size: Int, name: String = UUID().uuidString) throws -> URL {
        var bytes = Data(count: size)
        bytes.withUnsafeMutableBytes { arc4random_buf($0.baseAddress, size) }
        let url = directory.appending(path: name)
        try bytes.write(to: url)
        return url
    }

    func sparse(_ size: Int64, name: String = UUID().uuidString) throws -> URL {
        let url = directory.appending(path: name)
        let fd = open(url.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        defer { close(fd) }
        guard ftruncate(fd, off_t(size)) == 0 else { throw POSIXError(.EIO) }
        return url
    }

    var scratch: URL { directory.appending(path: "scratch-\(UUID().uuidString)") }
}
