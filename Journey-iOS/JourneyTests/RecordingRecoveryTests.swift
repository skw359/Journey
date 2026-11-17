import XCTest
@testable import Journey

/// Recordings that must not be lost: interrupted trips, zips that fail, uploads that fail.
/// Files go in the app's Documents folder under names unique to each test.
@MainActor
final class RecordingRecoveryTests: XCTestCase {
    private let header = "ts_ms,lat,lon,ele_m,speed_ms,waypoint,note\n"
    private let run = UUID().uuidString
    private var savedPairing: ServerPairing?
    private var uploadManager: UploadManager!

    private func file(_ name: String) -> URL { URL.documentsDirectory.appending(path: "route_\(run)-\(name)") }
    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }
    private func mine(_ urls: [URL]) -> [String] {
        urls.map(\.lastPathComponent).filter { $0.contains(run) }.sorted()
    }
    private var queued: [UploadQueueItem] { uploadManager.queue.filter { $0.fileName.contains(run) } }

    @discardableResult
    private func writeTrip(_ name: String, rows: Int = 3) throws -> URL {
        let url = file(name)
        var text = header
        for i in 0..<rows { text += "\(1_760_000_000_000 + i * 1000),40.\(i),-74.0,10.0,3.0,,\n" }
        try Data(text.utf8).write(to: url)
        return url
    }

    override func setUp() async throws {
        savedPairing = ServerPairing.stored
        ServerPairing(serverURL: "http://journey.test", bearerToken: "token").save()
        UploadStub.reset()
        URLProtocol.registerClass(UploadStub.self)
        uploadManager = UploadManager()
    }

    override func tearDown() async throws {
        for item in queued { uploadManager.remove(item: item) }
        let entries = (try? FileManager.default.contentsOfDirectory(at: URL.documentsDirectory, includingPropertiesForKeys: nil)) ?? []
        for url in entries where url.lastPathComponent.contains(run) { try? FileManager.default.removeItem(at: url) }
        URLProtocol.unregisterClass(UploadStub.self)
        if let savedPairing { savedPairing.save() } else { ServerPairing.clear() }
    }

    // MARK: Zipping

    func testZipWritesTheArchiveAndSaysSo() throws {
        let csv = try writeTrip("a.csv")
        let zip = file("a.zip")
        XCTAssertTrue(RecordingFiles.zip(csv, to: zip))
        XCTAssertTrue(exists(zip))
        XCTAssertTrue(exists(csv), "deleting the CSV is the caller's step, after this succeeds")
    }

    func testAFailedZipLeavesNoArchiveBehind() {
        let zip = file("missing.zip")
        XCTAssertFalse(RecordingFiles.zip(file("missing.csv"), to: zip))
        XCTAssertFalse(exists(zip))
    }

    // MARK: Leftovers at launch

    func testAnInterruptedTripIsZippedAndReturned() throws {
        let csv = try writeTrip("interrupted.csv")
        let found = mine(RecordingFiles.leftovers(active: nil, known: []))
        XCTAssertEqual(found, [file("interrupted.zip").lastPathComponent])
        XCTAssertTrue(exists(file("interrupted.zip")))
        XCTAssertFalse(exists(csv), "the CSV goes once its zip exists")
    }

    func testTheTripBeingRecordedIsLeftAlone() throws {
        let active = try writeTrip("active.csv")
        XCTAssertEqual(mine(RecordingFiles.leftovers(active: active, known: [])), [])
        XCTAssertTrue(exists(active))
        XCTAssertFalse(exists(file("active.zip")))
    }

    func testAHeaderOnlyFileIsNotATrip() throws {
        let empty = try writeTrip("empty.csv", rows: 0)
        XCTAssertEqual(mine(RecordingFiles.leftovers(active: nil, known: [])), [])
        XCTAssertFalse(exists(empty))
    }

    func testAZipThatNeverReachedTheQueueIsReturnedOnce() throws {
        let stray = file("stray.zip")
        let queuedAlready = file("queued.zip")
        try Data("zip".utf8).write(to: stray)
        try Data("zip".utf8).write(to: queuedAlready)
        let found = mine(RecordingFiles.leftovers(active: nil, known: [queuedAlready.lastPathComponent]))
        XCTAssertEqual(found, [stray.lastPathComponent])
    }

    func testACsvWhoseZipAlreadyExistsIsNotZippedAgain() throws {
        let csv = try writeTrip("both.csv")
        let zip = file("both.zip")
        try Data("first zip".utf8).write(to: zip)
        XCTAssertEqual(mine(RecordingFiles.leftovers(active: nil, known: [zip.lastPathComponent])), [])
        XCTAssertEqual(try Data(contentsOf: zip), Data("first zip".utf8))
        XCTAssertTrue(exists(csv))
    }

    func testRecoveredTripsAreQueuedForUploadOnlyOnce() throws {
        try writeTrip("recover.csv")
        uploadManager.recoverLeftoverRecordings()
        XCTAssertEqual(queued.map(\.fileName), [file("recover.zip").lastPathComponent])
        XCTAssertEqual(queued.first?.source, "iphone")
        uploadManager.recoverLeftoverRecordings()
        XCTAssertEqual(queued.count, 1)
    }

    // MARK: Retrying uploads

    private func enqueueTrip(_ name: String) throws -> UploadQueueItem {
        let zip = file(name)
        try Data("zipped trip".utf8).write(to: zip)
        uploadManager.enqueue(fileURL: zip, source: "iphone")
        return try XCTUnwrap(queued.first { $0.fileName == zip.lastPathComponent })
    }

    func testAFailedUploadIsRetriedWithoutAnyoneAsking() async throws {
        let item = try enqueueTrip("offline.zip")
        UploadStub.status = 503
        _ = await uploadManager.upload(item: item)
        guard case .failed = queued.first?.status else { return XCTFail("expected the upload to fail") }
        XCTAssertNotEqual(queued.first?.retriesAutomatically, false)
        XCTAssertTrue(exists(item.fileURL), "a failed upload keeps its file")

        UploadStub.status = 201
        await uploadManager.retryPending()
        XCTAssertTrue(queued.isEmpty)
        XCTAssertFalse(exists(item.fileURL))
        XCTAssertEqual(UploadStub.uploads.count, 2)
        XCTAssertTrue(String(decoding: UploadStub.uploads[1], as: UTF8.self).contains("name=\"timeZone\"\r\n\r\n\(TimeZone.current.identifier)\r\n"))
    }

    func testAFileTheServerRefusesWaitsForAManualRetry() async throws {
        let item = try enqueueTrip("refused.zip")
        UploadStub.status = 413
        _ = await uploadManager.upload(item: item)
        XCTAssertEqual(queued.first?.retriesAutomatically, false)

        UploadStub.status = 201
        await uploadManager.retryPending()
        XCTAssertEqual(UploadStub.uploads.count, 1, "not sent again on its own")
        XCTAssertEqual(queued.count, 1)

        await uploadManager.retryFailed()
        XCTAssertTrue(queued.isEmpty, "the Retry button still sends it")
    }

    func testNothingIsSentWithoutAPairing() async throws {
        _ = try enqueueTrip("unpaired.zip")
        ServerPairing.clear()
        await uploadManager.retryPending()
        XCTAssertEqual(UploadStub.uploads.count, 0)
        XCTAssertEqual(queued.count, 1)
    }

    // MARK: The saved queue

    func testASavedFailureIsKeptWhileItsFileExists() async throws {
        let item = try enqueueTrip("kept.zip")
        UploadStub.status = 500
        _ = await uploadManager.upload(item: item)

        // Loading the queue once deleted any failure whose message contained "201".
        let queueFile = URL.documentsDirectory.appending(path: "upload_queue.json")
        let saved = try String(contentsOf: queueFile, encoding: .utf8).replacingOccurrences(of: "HTTP error 500", with: "HTTP error 201")
        try saved.write(to: queueFile, atomically: true, encoding: .utf8)

        uploadManager = UploadManager()
        XCTAssertEqual(queued.map(\.fileName), [item.fileName])
        XCTAssertTrue(exists(item.fileURL))

        // An item whose file is gone can never upload, so it is dropped.
        try FileManager.default.removeItem(at: item.fileURL)
        uploadManager = UploadManager()
        XCTAssertTrue(queued.isEmpty)
    }
}

private final class UploadStub: URLProtocol {
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
