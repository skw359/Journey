import XCTest
@testable import Journey

/// Sends real files through URLSession to a real Journey server, sampling this process's memory
/// throughout. Skipped unless pointed at a throwaway server, since it stores what it sends:
///
///     TEST_RUNNER_JOURNEY_TEST_SERVER=http://127.0.0.1:54331
///     TEST_RUNNER_JOURNEY_TEST_TOKEN=<pairing token>
///     TEST_RUNNER_JOURNEY_TEST_ROUTE=<journey id>
///     TEST_RUNNER_JOURNEY_TEST_FILES=/path/a.mov,/path/b.mov
@MainActor
final class RealServerUploadTests: XCTestCase {
    func testUploadsRealFilesWithMemoryBounded() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JOURNEY_TEST_SERVER"], let token = env["JOURNEY_TEST_TOKEN"],
              let route = env["JOURNEY_TEST_ROUTE"], let list = env["JOURNEY_TEST_FILES"] else {
            throw XCTSkip("No throwaway server configured")
        }
        let files = try TestFiles()

        for path in list.split(separator: ",").map(String.init) {
            let source = URL(filePath: path)
            let directory = files.directory.appending(path: UUID().uuidString)
            VideoUploadStorage.prepare(directory)
            let copy = directory.appending(path: "picked-\(UUID().uuidString).\(source.pathExtension)")
            try FileManager.default.copyItem(at: source, to: copy)

            let queue = VideoUploadQueue(
                directory: directory,
                temporaryDirectory: directory.appending(path: "tmp"),
                makeRequest: { path, method in
                    var request = URLRequest(url: URL(string: "\(server)\(path)")!)
                    request.httpMethod = method
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    request.timeoutInterval = 120
                    return request
                },
                currentAccount: { "test" },
                background: nil
            )
            VideoUploadStorage.prepare(directory.appending(path: "tmp"))

            let sampler = FootprintSampler()
            sampler.start()
            let started = Date()
            let video = PickedVideo(url: copy, filename: "VID_test.\(source.pathExtension)", mimeType: "video/quicktime")
            let enqueued = try await queue.enqueue(video, journeyID: route)
            let job = try XCTUnwrap(enqueued)
            let progress = Recorder<Double>()
            let result = try await queue.upload(job) { progress.add($0) }
            let peak = sampler.stop()

            let megabytes = job.size / (1 << 20)
            let seconds = Date().timeIntervalSince(started)
            print("E2E \(source.lastPathComponent): \(megabytes) MB, base \(sampler.base) MB, peak \(peak) MB, grew \(peak - sampler.base) MB, \(Int(seconds)) s, id \(result.photos.first?.id ?? "?"), status \(result.photos.first?.status ?? "?"), progress reports \(progress.values.count)")
            XCTAssertEqual(result.photos.count, 1)
            XCTAssertEqual(progress.values.last, 1)
            XCTAssertLessThan(peak - sampler.base, 64, "memory should not follow file size")
            XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
        }
    }
}

/// Samples physical footprint on its own thread, since a peak can fall between requests.
final class FootprintSampler: @unchecked Sendable {
    private let lock = NSLock()
    private var running = false
    private var peak: UInt64 = 0
    private(set) var base: Int64 = 0

    func start() {
        base = Int64(FakeUploadServer.footprint() >> 20)
        running = true
        Thread.detachNewThread { [self] in
            while lock.withLock({ running }) {
                let now = FakeUploadServer.footprint()
                lock.withLock { peak = max(peak, now) }
                Thread.sleep(forTimeInterval: 0.02)
            }
        }
    }

    func stop() -> Int64 {
        lock.withLock {
            running = false
            return Int64(peak >> 20)
        }
    }
}

extension RealServerUploadTests {
    /// Pairs the app with the throwaway server, for driving it by hand or from UI tests.
    func testPairWithTestServer() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JOURNEY_TEST_PAIR_SERVER"], let token = env["JOURNEY_TEST_TOKEN"] else {
            throw XCTSkip("No throwaway server configured")
        }
        ServerPairing(serverURL: server, bearerToken: token).save()
        XCTAssertEqual(ServerPairing.stored?.baseURL, server)
    }
}
