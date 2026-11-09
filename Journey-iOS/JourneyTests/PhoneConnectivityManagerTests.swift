import WatchConnectivity
import XCTest
@testable import Journey

/// Trips arriving from the watch. The simulator never delivers transferred files,
/// so these call the delegate directly with a file built by hand.
@MainActor
final class PhoneConnectivityManagerTests: XCTestCase {
    private var savedPairing: ServerPairing?
    private var uploadManager: UploadManager!
    private var manager: PhoneConnectivityManager!
    private let tripName = "route_\(UUID().uuidString).zip"
    private let tripContents = Data("zipped trip".utf8)

    private var savedTrip: URL { URL.documentsDirectory.appending(path: tripName) }
    private var queuedTrip: UploadQueueItem? { uploadManager.queue.first { $0.fileName == tripName } }

    override func setUp() async throws {
        savedPairing = ServerPairing.stored
        ServerPairing(serverURL: "http://journey.test", bearerToken: "token").save()
        StubServer.reset()
        URLProtocol.registerClass(StubServer.self)
        uploadManager = UploadManager()
        manager = PhoneConnectivityManager(uploadManager: uploadManager)
    }

    override func tearDown() async throws {
        if let queuedTrip { uploadManager.remove(item: queuedTrip) }
        URLProtocol.unregisterClass(StubServer.self)
        if let savedPairing { savedPairing.save() } else { ServerPairing.clear() }
    }

    private func receivedFile() throws -> WCSessionFile {
        let url = FileManager.default.temporaryDirectory.appending(path: tripName)
        try tripContents.write(to: url)
        let file = WCSessionFile()
        file.setValue(url, forKey: "fileURL")
        return file
    }

    private func waitUntil(_ condition: () -> Bool, line: UInt = #line) async throws {
        for _ in 0..<250 where !condition() { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), line: line)
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func testTripIsKeptBeforeTheDelegateReturnsThenUploadedAsAWatchTrip() async throws {
        let file = try receivedFile()
        manager.session(.default, didReceive: file)

        // The system deletes its copy as soon as the delegate returns.
        XCTAssertFalse(exists(file.fileURL))
        XCTAssertTrue(exists(savedTrip))

        try await waitUntil { StubServer.uploads.count == 1 && queuedTrip == nil }
        let upload = String(decoding: StubServer.uploads[0], as: UTF8.self)
        XCTAssertTrue(upload.contains("name=\"source\"\r\n\r\nwatch\r\n"))
        XCTAssertTrue(upload.contains("filename=\"\(tripName)\""))
        XCTAssertTrue(upload.contains("zipped trip"))
        XCTAssertFalse(exists(savedTrip))
    }

    func testFailedUploadStaysQueuedAndCanBeRetried() async throws {
        StubServer.status = 500
        manager.session(.default, didReceive: try receivedFile())

        try await waitUntil {
            if case .failed = queuedTrip?.status { return true }
            return false
        }
        XCTAssertEqual(queuedTrip?.source, "watch")
        XCTAssertTrue(exists(savedTrip))

        StubServer.status = 201
        await uploadManager.retryFailed()
        XCTAssertNil(queuedTrip)
        XCTAssertFalse(exists(savedTrip))
    }

    func testMessagesGetAReply() {
        var replied = false
        manager.session(.default, didReceiveMessage: ["status": "recording_started"]) { _ in replied = true }
        XCTAssertTrue(replied)
    }
}

private final class StubServer: URLProtocol {
    static var status = 201
    static var uploads: [Data] = []

    static func reset() {
        status = 201
        uploads = []
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "journey.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.uploads.append(Self.body(of: request))
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"accepted":true,"saved":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    /// URLSession hands a protocol the body as a stream.
    private static func body(of request: URLRequest) -> Data {
        guard let stream = request.httpBodyStream else { return request.httpBody ?? Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while case let count = stream.read(&buffer, maxLength: buffer.count), count > 0 {
            data.append(buffer, count: count)
        }
        return data
    }
}
