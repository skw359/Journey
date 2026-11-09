import XCTest
@testable import Journey

@MainActor
final class VideoUploadQueueTests: XCTestCase {
    private var files: TestFiles!
    private var directory: URL!
    private var temporary: URL!

    override func setUp() async throws {
        files = try TestFiles()
        directory = files.directory.appending(path: "MediaUploads")
        temporary = files.directory.appending(path: "tmp")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    }

    private func queue(_ server: FakeUploadServer, account: String? = "account") -> VideoUploadQueue {
        VideoUploadQueue(
            directory: directory,
            temporaryDirectory: temporary,
            transport: server,
            makeRequest: { path, method in
                var request = URLRequest(url: URL(string: "http://server\(path)")!)
                request.httpMethod = method
                return request
            },
            currentAccount: { account },
            background: nil,
            sleep: { _ in }
        )
    }

    private func picked(_ size: Int, name: String = "picked-\(UUID().uuidString).mov") throws -> PickedVideo {
        let url = directory.appending(path: name)
        var bytes = Data(count: size)
        bytes.withUnsafeMutableBytes { arc4random_buf($0.baseAddress, size) }
        try bytes.write(to: url)
        return PickedVideo(url: url, filename: "VID.mov", mimeType: "video/quicktime")
    }

    private func names(in url: URL) -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? [])
    }

    func testFinishedUploadLeavesNoFilesAndNoJournalEntry() async throws {
        let server = FakeUploadServer()
        let queue = queue(server)
        let video = try picked(1000)
        let enqueuedJob = try await queue.enqueue(video, journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)
        let result = try await queue.upload(job) { _ in }
        XCTAssertEqual(result.photos.first?.id, "video-1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: video.url.path))
        XCTAssertEqual(names(in: temporary), [], "no scratch file left")
        XCTAssertEqual(self.queue(server).claimInterrupted(), [], "nothing to resume")
    }

    func testAJobSurvivesTheAppBeingKilled() async throws {
        let server = FakeUploadServer()
        let enqueuedKept = try await queue(server).enqueue(picked(1000), journeyID: "j")
        let kept = try XCTUnwrap(enqueuedKept)

        // A new queue reads only what the old one left on disk, as after a relaunch
        let relaunched = queue(server)
        let claimed = relaunched.claimInterrupted()
        XCTAssertEqual(claimed.map(\.id), [kept.id])
        XCTAssertEqual(relaunched.claimInterrupted(), [], "claimed only once")
        XCTAssertTrue(FileManager.default.fileExists(atPath: relaunched.fileURL(for: kept).path))

        let result = try await relaunched.upload(claimed[0]) { _ in }
        XCTAssertEqual(result.photos.count, 1)
        XCTAssertEqual(queue(server).claimInterrupted(), [])
    }

    func testARelaunchContinuesFromTheServersOffsetRatherThanStartingOver() async throws {
        let server = FakeUploadServer()
        let size = Int(ChunkedMediaUploader.defaultChunkBytes) + 1000
        let first = queue(server)
        let enqueuedJob = try await first.enqueue(picked(size), journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)
        var saved = job
        saved.serverUploadID = "upload-earlier"
        try JSONEncoder().encode([saved]).write(to: directory.appending(path: "journal.json"))
        server.seed(id: "upload-earlier", size: Int64(size), received: ChunkedMediaUploader.defaultChunkBytes, key: job.key)

        let relaunched = queue(server)
        let claimed = relaunched.claimInterrupted()
        XCTAssertEqual(claimed.first?.serverUploadID, "upload-earlier")
        _ = try await relaunched.upload(claimed[0]) { _ in }
        XCTAssertEqual(server.requests.map(\.method), ["GET", "PUT"])
        XCTAssertEqual(server.requests.last?.bodyBytes, 1000)
    }

    func testTheServerIDIsSavedSoARelaunchDoesNotStartOver() async throws {
        let server = FakeUploadServer()
        let queue = queue(server)
        let enqueuedJob = try await queue.enqueue(picked(200_000), journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)
        // Hold the attempt inside its first piece, which is after the id was recorded
        let started = expectation(description: "first piece")
        started.assertForOverFulfill = false
        server.setOnPiece { started.fulfill() }
        let task = Task { try await queue.upload(job) { _ in } }
        await fulfillment(of: [started], timeout: 10)
        let saved = try JSONDecoder().decode([ChunkedUploadJob].self, from: Data(contentsOf: directory.appending(path: "journal.json")))
        XCTAssertEqual(saved.first?.serverUploadID, "upload-1")
        _ = try? await task.value
    }

    func testTheSameVideoTwiceOnlyGoesUpOnce() async throws {
        let server = FakeUploadServer()
        let queue = queue(server)
        let video = try picked(1000)
        let copy = directory.appending(path: "picked-copy.mov")
        try FileManager.default.copyItem(at: video.url, to: copy)

        let first = try await queue.enqueue(video, journeyID: "j")
        XCTAssertNotNil(first)
        let again = try await queue.enqueue(PickedVideo(url: copy, filename: "VID2.mov", mimeType: "video/quicktime"), journeyID: "j")
        XCTAssertNil(again)
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path), "the duplicate's copy is removed")
    }

    func testTheSameVideoCanGoToDifferentJourneys() async throws {
        let queue = queue(FakeUploadServer())
        let video = try picked(1000)
        let copy = directory.appending(path: "picked-copy.mov")
        try FileManager.default.copyItem(at: video.url, to: copy)
        let first = try await queue.enqueue(video, journeyID: "one")
        let second = try await queue.enqueue(PickedVideo(url: copy, filename: "V.mov", mimeType: "video/quicktime"), journeyID: "two")
        XCTAssertNotNil(first)
        XCTAssertNotNil(second)
    }

    func testCancellingRemovesTheCopyAndForgetsTheJob() async throws {
        let server = FakeUploadServer()
        let queue = queue(server)
        let video = try picked(ChunkFile.bufferBytes * 40)
        let enqueuedJob = try await queue.enqueue(video, journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)
        let holder = Recorder<Task<APIService.MediaUploadResult, Error>>()
        server.setOnPiece { holder.values.first?.cancel() }
        let task = Task { try await queue.upload(job) { _ in } }
        holder.add(task)
        do {
            _ = try await task.value
            XCTFail("should be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: video.url.path))
        XCTAssertEqual(self.queue(server).claimInterrupted(), [])
    }

    func testOutOfBackgroundTimePausesThenResumesWithoutLosingAnything() async throws {
        let server = FakeUploadServer()
        let queue = queue(server)
        let size = ChunkFile.bufferBytes * 40
        let video = try picked(size)
        let original = try Data(contentsOf: video.url)
        let enqueuedJob = try await queue.enqueue(video, journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)

        let reachedPiece = expectation(description: "a piece is on its way")
        reachedPiece.assertForOverFulfill = false
        server.setOnPiece {
            reachedPiece.fulfill()
        }
        let task = Task { try await queue.upload(job) { _ in } }
        await fulfillment(of: [reachedPiece], timeout: 30)
        queue.suspendForBackground()

        // Stopped, not failed: the job and its file stay until the app comes back
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(FileManager.default.fileExists(atPath: video.url.path))
        let during = server.requests.count

        queue.appDidBecomeActive()
        let result = try await task.value
        XCTAssertEqual(result.photos.count, 1)
        XCTAssertGreaterThanOrEqual(server.requests.count, during)
        XCTAssertEqual(server.stored, original)
        XCTAssertEqual(server.finishCount, 1)
    }

    func testPermanentFailureDropsTheJobButReportsIt() async throws {
        let server = FakeUploadServer()
        let queue = queue(server)
        let video = try picked(1000)
        let enqueuedJob = try await queue.enqueue(video, journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)
        server.inject(.status(404, "Journey not found"), on: "POST")
        do {
            _ = try await queue.upload(job) { _ in }
            XCTFail("should fail")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Journey not found")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: video.url.path))
        XCTAssertEqual(self.queue(server).claimInterrupted(), [])
    }

    func testJobsFromAnotherPairingAreDropped() async throws {
        let server = FakeUploadServer()
        let video = try picked(1000)
        _ = try await queue(server, account: "old").enqueue(video, journeyID: "j")
        XCTAssertEqual(queue(server, account: "new").claimInterrupted(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: video.url.path))
    }

    func testJobsWaitWhenThePairingCantBeReadYet() async throws {
        let server = FakeUploadServer()
        let video = try picked(1000)
        let enqueuedJob = try await queue(server).enqueue(video, journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)
        XCTAssertEqual(queue(server, account: nil).claimInterrupted(), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: video.url.path))
        XCTAssertEqual(queue(server).claimInterrupted().map(\.id), [job.id])
    }

    func testAPairingChangePartWayStopsTheUpload() async throws {
        let server = FakeUploadServer()
        final class Box: @unchecked Sendable { var account: String? = "first" }
        let box = Box()
        let queue = VideoUploadQueue(
            directory: directory, temporaryDirectory: temporary, transport: server,
            makeRequest: { path, method in
                var request = URLRequest(url: URL(string: "http://server\(path)")!)
                request.httpMethod = method
                return request
            },
            currentAccount: { box.account }, background: nil, sleep: { _ in }
        )
        let enqueuedJob = try await queue.enqueue(picked(ChunkFile.bufferBytes * 40), journeyID: "j")
        let job = try XCTUnwrap(enqueuedJob)
        box.account = "second"
        do {
            _ = try await queue.upload(job) { _ in }
            XCTFail("should fail")
        } catch {
            XCTAssertEqual(error as? ChunkedUploadError, .server(status: 401, message: "Not paired with server"))
        }
        XCTAssertTrue(server.requests.isEmpty, "nothing reaches the other account")
    }

    func testAFileThatDisappearedIsDroppedFromTheJournal() async throws {
        let server = FakeUploadServer()
        let video = try picked(1000)
        _ = try await queue(server).enqueue(video, journeyID: "j")
        try FileManager.default.removeItem(at: video.url)
        XCTAssertEqual(queue(server).claimInterrupted(), [])
    }

    func testRemoveOrphansKeepsJobsAndClearsTheRest() async throws {
        let server = FakeUploadServer()
        let queue = queue(server)
        let kept = try picked(1000)
        _ = try await queue.enqueue(kept, journeyID: "j")
        let orphan = try picked(10, name: "picked-orphan.mov")
        let manager = FileManager.default
        for name in ["picked-old.mov", "upload-old", "upload-chunk-old", "unrelated.txt"] {
            manager.createFile(atPath: temporary.appending(path: name).path, contents: Data("x".utf8))
        }

        queue.removeOrphans()

        XCTAssertTrue(manager.fileExists(atPath: kept.url.path))
        XCTAssertFalse(manager.fileExists(atPath: orphan.url.path))
        XCTAssertEqual(names(in: temporary), ["unrelated.txt"])

        // Only the first call acts, or a video being imported would look like an orphan
        let importing = try picked(10, name: "picked-importing.mov")
        queue.removeOrphans()
        XCTAssertTrue(manager.fileExists(atPath: importing.url.path))
    }

    func testEnqueueWithoutAPairingFailsAndRemovesTheCopy() async throws {
        let queue = queue(FakeUploadServer(), account: nil)
        let video = try picked(1000)
        do {
            _ = try await queue.enqueue(video, journeyID: "j")
            XCTFail("should fail")
        } catch {
            XCTAssertFalse(FileManager.default.fileExists(atPath: video.url.path))
        }
    }
}
