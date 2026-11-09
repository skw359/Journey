import XCTest
@testable import Journey

final class ChunkedMediaUploaderTests: XCTestCase {
    private let piece: Int64 = 64 * 1024
    private var files: TestFiles!

    override func setUpWithError() throws {
        files = try TestFiles()
    }

    private func job(size: Int64, serverUploadID: String? = nil) -> ChunkedUploadJob {
        ChunkedUploadJob(
            id: UUID(), journeyID: "journey", localName: "video.mov", serverName: "VID.mov",
            mimeType: "video/quicktime", size: size, key: "key", account: "account", serverUploadID: serverUploadID
        )
    }

    private func uploader(_ server: FakeUploadServer, maxFailures: Int = 8) -> ChunkedMediaUploader {
        var uploader = ChunkedMediaUploader(transport: server, makeRequest: { path, method in
            var request = URLRequest(url: URL(string: "http://server\(path)")!)
            request.httpMethod = method
            return request
        })
        uploader.chunkBytes = piece
        uploader.maxFailures = maxFailures
        uploader.sleep = { _ in }
        return uploader
    }

    private func run(
        _ uploader: ChunkedMediaUploader,
        _ job: ChunkedUploadJob,
        file: URL,
        scratch: URL? = nil,
        onUploadID: @escaping @Sendable (String?) async -> Void = { _ in },
        onProgress: @escaping @Sendable (Double) -> Void = { _ in }
    ) async throws -> Data {
        try await uploader.upload(job, file: file, scratch: scratch ?? files.scratch, onUploadID: onUploadID, onProgress: onProgress)
    }

    func testSendsAFileSmallerThanOnePieceInOneRequest() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        let response = try await run(uploader(server), job(size: 1000), file: file)
        XCTAssertEqual(server.stored, try Data(contentsOf: file))
        XCTAssertEqual(server.requests.map(\.method), ["POST", "PUT"])
        XCTAssertEqual(server.finishCount, 1)
        let decoded = try JSONDecoder().decode(APIService.MediaUploadResult.self, from: response)
        XCTAssertEqual(decoded.photos.first?.id, "video-1")
    }

    func testSplitsALargeFileIntoPiecesInOrderWithoutTheJSONContentType() async throws {
        let size = Int(piece) * 3 + 5
        let file = try files.random(size)
        let server = FakeUploadServer()
        _ = try await run(uploader(server), job(size: Int64(size)), file: file)

        XCTAssertEqual(server.stored, try Data(contentsOf: file))
        let puts = server.requests.filter { $0.method == "PUT" }
        XCTAssertEqual(puts.map(\.bodyBytes), [piece, piece, piece, 5])
        // express.json() would swallow a piece sent as JSON, and refuse one over 100 KB
        XCTAssertTrue(puts.allSatisfy { $0.contentType == "application/octet-stream" })
    }

    func testAPieceCutOffPartWayResumesFromWhatTheServerKept() async throws {
        let size = Int(piece) * 3
        let file = try files.random(size)
        let server = FakeUploadServer()
        server.inject(.dropAfter(1234), on: "PUT")
        _ = try await run(uploader(server), job(size: Int64(size)), file: file)
        XCTAssertEqual(server.stored, try Data(contentsOf: file), "no bytes lost, repeated or out of order")
        XCTAssertEqual(server.finishCount, 1)
    }

    func testAFinalResponseThatGotLostIsNotSentAgain() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        server.inject(.loseResponse, on: "PUT")
        let response = try await run(uploader(server), job(size: 1000), file: file)
        XCTAssertEqual(server.finishCount, 1)
        XCTAssertEqual(server.stored.count, 1000)
        XCTAssertEqual(server.requests.map(\.method), ["POST", "PUT", "GET"])
        XCTAssertNoThrow(try JSONDecoder().decode(APIService.MediaUploadResult.self, from: response))
    }

    func testResumesAKnownUploadFromTheServersOffset() async throws {
        let size = Int(piece) * 2
        let file = try files.random(size)
        let server = FakeUploadServer()
        server.seed(id: "upload-saved", size: Int64(size), received: piece, key: "key")
        _ = try await run(uploader(server), job(size: Int64(size), serverUploadID: "upload-saved"), file: file)

        XCTAssertEqual(server.requests.map(\.method), ["GET", "PUT"], "no new upload is started")
        XCTAssertEqual(server.requests.last?.bodyBytes, piece)
        XCTAssertEqual(server.stored, try Data(contentsOf: file).suffix(Int(piece)))
    }

    func testSameKeyPicksUpAnUnfinishedUploadWithoutAKnownID() async throws {
        let size = Int(piece) * 2
        let file = try files.random(size)
        let server = FakeUploadServer()
        server.seed(id: "upload-other-run", size: Int64(size), received: piece, key: "key")
        _ = try await run(uploader(server), job(size: Int64(size)), file: file)
        XCTAssertEqual(server.requests.filter { $0.method == "PUT" }.map(\.bodyBytes), [piece])
    }

    func testUploadForgottenByTheServerStartsAgainOnce() async throws {
        let size = Int(piece) * 2
        let file = try files.random(size)
        let server = FakeUploadServer()
        _ = try await run(uploader(server), job(size: Int64(size), serverUploadID: "swept-away"), file: file)
        XCTAssertEqual(server.requests.map(\.method), ["GET", "POST", "PUT", "PUT"])
        XCTAssertEqual(server.stored, try Data(contentsOf: file))
    }

    func testRecordsTheServerIDAndClearsItOnRestart() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        let recorded = Recorder<String?>()
        _ = try await run(uploader(server), job(size: 1000, serverUploadID: "swept-away"), file: file, onUploadID: { recorded.add($0) })
        XCTAssertEqual(recorded.values, [nil, "upload-1"])
    }

    func testServerErrorsThatCanPassAreRetried() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        for code in [500, 502, 503, 504, 408, 429] { server.inject(.status(code), on: "PUT") }
        _ = try await run(uploader(server), job(size: 1000), file: file)
        XCTAssertEqual(server.finishCount, 1)
    }

    func testConflictResyncsThenCarriesOn() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        server.inject(.status(409, "This upload is already receiving data"), on: "PUT")
        _ = try await run(uploader(server), job(size: 1000), file: file)
        XCTAssertEqual(server.finishCount, 1)
        XCTAssertEqual(server.stored.count, 1000)
    }

    func testPermanentRefusalsStopStraightAwayWithTheServersWords() async throws {
        for (code, message) in [(507, "The server ran out of disk space"), (400, "Bad"), (401, "Unauthorized"), (413, "Too big")] {
            let file = try files.random(1000)
            let server = FakeUploadServer()
            server.inject(.status(code, message), on: "POST")
            do {
                _ = try await run(uploader(server), job(size: 1000), file: file)
                XCTFail("\(code) should fail")
            } catch {
                XCTAssertEqual(error as? ChunkedUploadError, .server(status: code, message: message))
                XCTAssertEqual(error.localizedDescription, message)
            }
            XCTAssertEqual(server.requests.count, 1, "\(code) is not retried")
        }
    }

    func testGivesUpAfterTooManyFailuresInARow() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        for _ in 0..<20 { server.inject(.urlError(.networkConnectionLost), on: "POST") }
        do {
            _ = try await run(uploader(server, maxFailures: 3), job(size: 1000), file: file)
            XCTFail("should give up")
        } catch {
            XCTAssertEqual(error as? ChunkedUploadError, .interrupted)
        }
        XCTAssertEqual(server.requests.count, 4)
    }

    func testProgressResetsTheFailureCountSoAFlakyLinkStillFinishes() async throws {
        let size = Int(piece) * 6
        let file = try files.random(size)
        let server = FakeUploadServer()
        for _ in 0..<20 { server.inject(.dropAfter(piece / 2), on: "PUT") }
        _ = try await run(uploader(server, maxFailures: 2), job(size: Int64(size)), file: file)
        XCTAssertEqual(server.stored, try Data(contentsOf: file))
    }

    func testBacksOffLongerEachTimeUpToALimit() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        for _ in 0..<8 { server.inject(.status(503), on: "POST") }
        var uploader = uploader(server)
        let delays = Recorder<Duration>()
        uploader.sleep = { delays.add($0) }
        _ = try await run(uploader, job(size: 1000), file: file)
        XCTAssertEqual(delays.values, [1, 2, 4, 8, 16, 30, 30, 30].map { .seconds($0) })
    }

    func testPermanentNetworkErrorsAreNotRetried() async throws {
        let file = try files.random(1000)
        let server = FakeUploadServer()
        server.inject(.urlError(.serverCertificateUntrusted), on: "POST")
        do {
            _ = try await run(uploader(server), job(size: 1000), file: file)
            XCTFail("should fail")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .serverCertificateUntrusted)
        }
        XCTAssertEqual(server.requests.count, 1)
    }

    func testCancellingStopsSendingAndRemovesTheScratchFile() async throws {
        let size = Int(piece) * 20
        let file = try files.random(size)
        let scratch = files.scratch
        let server = FakeUploadServer()
        let holder = Recorder<Task<Data, Error>>()
        server.setOnPiece { if server.requests.count >= 3 { holder.values.first?.cancel() } }
        let uploader = uploader(server)
        let task = Task { [job = job(size: Int64(size))] in
            try await uploader.upload(job, file: file, scratch: scratch, onUploadID: { _ in }, onProgress: { _ in })
        }
        holder.add(task)
        do {
            _ = try await task.value
            XCTFail("should be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertLessThan(server.requests.count, 22)
        XCTAssertEqual(server.finishCount, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: scratch.path))
    }

    func testAFileOfTheWrongSizeIsRefusedBeforeAnythingIsSent() async throws {
        let file = try files.random(999)
        let server = FakeUploadServer()
        do {
            _ = try await run(uploader(server), job(size: 1000), file: file)
            XCTFail("should fail")
        } catch {
            XCTAssertEqual(error as? ChunkedUploadError, .sourceChanged)
        }
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testProgressOnlyMovesForwardAndEndsAtOne() async throws {
        let size = Int(piece) * 4
        let file = try files.random(size)
        let server = FakeUploadServer()
        server.inject(.dropAfter(piece / 2), on: "PUT")
        let seen = Recorder<Double>()
        _ = try await run(uploader(server), job(size: Int64(size)), file: file, onProgress: { seen.add($0) })
        XCTAssertEqual(seen.values, seen.values.sorted())
        XCTAssertEqual(seen.values.last, 1)
    }

    func testProgressIsThrottledToAboutOnePercentSteps() {
        let seen = Recorder<Double>()
        let meter = UploadProgressMeter(total: 1_000_000) { seen.add($0) }
        for sent in stride(from: Int64(0), through: 1_000_000, by: 100) { meter.update(sent: sent) }
        XCTAssertLessThanOrEqual(seen.values.count, 102)
        XCTAssertEqual(seen.values.last, 1)
    }

    func testChunksAreCopiedExactly() throws {
        let file = try files.random(3_000_000)
        let bytes = try Data(contentsOf: file)
        let output = files.scratch
        try ChunkFile.copySlice(of: file, offset: 1_234_567, length: 1_500_000, to: output)
        XCTAssertEqual(try Data(contentsOf: output), bytes.subdata(in: 1_234_567..<2_734_567))
        // A shorter copy into the same scratch file leaves nothing of the longer one
        try ChunkFile.copySlice(of: file, offset: 0, length: 10, to: output)
        XCTAssertEqual(try ChunkFile.size(of: output), 10)
    }

    func testCopyingPastTheEndOfTheFileFails() throws {
        let file = try files.random(100)
        XCTAssertThrowsError(try ChunkFile.copySlice(of: file, offset: 50, length: 100, to: files.scratch)) {
            XCTAssertEqual($0 as? ChunkedUploadError, .sourceChanged)
        }
    }

    func testFingerprintMatchesCopiesAndNoticesDifferences() throws {
        let file = try files.random(5_000_000)
        let copy = files.directory.appending(path: "copy")
        try FileManager.default.copyItem(at: file, to: copy)
        XCTAssertEqual(try ChunkFile.fingerprint(of: file), try ChunkFile.fingerprint(of: copy))

        var tail = try Data(contentsOf: file)
        tail[tail.count - 1] &+= 1
        let changedTail = files.directory.appending(path: "tail")
        try tail.write(to: changedTail)
        XCTAssertNotEqual(try ChunkFile.fingerprint(of: file), try ChunkFile.fingerprint(of: changedTail))

        var head = try Data(contentsOf: file)
        head[0] &+= 1
        let changedHead = files.directory.appending(path: "head")
        try head.write(to: changedHead)
        XCTAssertNotEqual(try ChunkFile.fingerprint(of: file), try ChunkFile.fingerprint(of: changedHead))
    }

    func testFingerprintOfAFileSmallerThanTheBuffer() throws {
        XCTAssertTrue(try ChunkFile.fingerprint(of: files.random(10)).hasPrefix("ios:10:"))
    }

    func testRecognisesOutOfSpaceErrorsHoweverDeeplyWrapped() {
        XCTAssertTrue(ChunkedUploadError.isOutOfSpace(CocoaError(.fileWriteOutOfSpace)))
        XCTAssertTrue(ChunkedUploadError.isOutOfSpace(POSIXError(.ENOSPC)))
        let wrapped = NSError(domain: "Transfer", code: 1, userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))])
        XCTAssertTrue(ChunkedUploadError.isOutOfSpace(wrapped))
        XCTAssertFalse(ChunkedUploadError.isOutOfSpace(CocoaError(.fileReadNoSuchFile)))
    }

    /// Everything a real send does except the network: 5 GB through the real chunk copier.
    func testMemoryDoesNotGrowWithFileSize() async throws {
        let size: Int64 = 5 << 30
        let file = try files.sparse(size)
        let server = FakeUploadServer(keepBytes: false)
        var uploader = uploader(server)
        uploader.chunkBytes = ChunkedMediaUploader.defaultChunkBytes
        let before = FakeUploadServer.footprint()
        _ = try await run(uploader, job(size: size), file: file)
        let growth = Double(server.peakFootprint.subtractingReportingOverflow(before).partialValue) / 1_048_576
        print("5 GB chunk pass: footprint grew \(growth) MB")
        XCTAssertEqual(server.requests.filter { $0.method == "PUT" }.count, 160)
        XCTAssertLessThan(growth, 40)
    }
}

final class Recorder<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Value] = []

    var values: [Value] { lock.withLock { stored } }

    func add(_ value: Value) {
        lock.withLock { stored.append(value) }
    }
}
