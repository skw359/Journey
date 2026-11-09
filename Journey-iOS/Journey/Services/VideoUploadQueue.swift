// Persistent queue of video uploads.

import UIKit
import BackgroundTasks

nonisolated struct PickedVideo: Sendable {
    let url: URL
    let filename: String
    let mimeType: String

    func discard() {
        try? FileManager.default.removeItem(at: url)
    }
}

nonisolated enum VideoUploadStorage {
    static var directory: URL {
        let url = URL.applicationSupportDirectory.appending(path: "MediaUploads", directoryHint: .isDirectory)
        prepare(url)
        return url
    }

    static func prepare(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var folder = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
    }
}

@MainActor
final class VideoUploadQueue {
    static let shared = VideoUploadQueue(background: .shared)

    private static let journalName = "journal.json"

    private let directory: URL
    private let temporaryDirectory: URL
    private let transport: any ChunkedUploadTransport
    private let makeRequest: ChunkedMediaUploader.RequestBuilder
    private let currentAccount: @MainActor () -> String?
    private let background: UploadBackgroundTime?
    private let sleep: (@Sendable (Duration) async throws -> Void)?

    private var jobs: [ChunkedUploadJob] = []
    private var claimed: Set<UUID> = []
    private var attempts: [UUID: Task<Data, Error>] = [:]
    private var cancelled: Set<UUID> = []
    private var isSuspended = false
    private var hasRemovedOrphans = false
    private var resumeWaiters: [CheckedContinuation<Void, Never>] = []

    init(
        directory: URL = VideoUploadStorage.directory,
        temporaryDirectory: URL = FileManager.default.temporaryDirectory,
        transport: any ChunkedUploadTransport = URLSessionChunkTransport(),
        makeRequest: @escaping ChunkedMediaUploader.RequestBuilder = VideoUploadQueue.pairedRequest,
        currentAccount: @escaping @MainActor () -> String? = VideoUploadQueue.pairedAccount,
        background: UploadBackgroundTime?,
        sleep: (@Sendable (Duration) async throws -> Void)? = nil
    ) {
        self.directory = directory
        self.temporaryDirectory = temporaryDirectory
        self.transport = transport
        self.makeRequest = makeRequest
        self.currentAccount = currentAccount
        self.background = background
        self.sleep = sleep
        jobs = Self.loadJournal(in: directory)
        background?.onOutOfTime = { [weak self] in self?.suspendForBackground() }
    }

    func enqueue(_ video: PickedVideo, journeyID: String) async throws -> ChunkedUploadJob? {
        guard let account = currentAccount() else {
            video.discard()
            throw ChunkedUploadError.server(status: 401, message: "Not paired with server")
        }
        let fingerprint: (key: String, size: Int64)
        do {
            fingerprint = try await Task.detached(priority: .userInitiated) {
                (try ChunkFile.fingerprint(of: video.url), try ChunkFile.size(of: video.url))
            }.value
        } catch {
            video.discard()
            throw error
        }
        if jobs.contains(where: { $0.journeyID == journeyID && $0.key == fingerprint.key }) {
            video.discard()
            return nil
        }
        let job = ChunkedUploadJob(
            id: UUID(),
            journeyID: journeyID,
            localName: video.url.lastPathComponent,
            serverName: video.filename,
            mimeType: video.mimeType,
            size: fingerprint.size,
            key: fingerprint.key,
            account: account,
            serverUploadID: nil
        )
        jobs.append(job)
        claimed.insert(job.id)
        saveJournal()
        return job
    }

    func claimInterrupted() -> [ChunkedUploadJob] {
        guard let account = currentAccount() else { return [] }
        for job in jobs where job.account != account && !claimed.contains(job.id) {
            discard(job.id)
        }
        let waiting = jobs.filter { !claimed.contains($0.id) }
        claimed.formUnion(waiting.map(\.id))
        return waiting
    }

    func fileURL(for job: ChunkedUploadJob) -> URL {
        directory.appending(path: job.localName, directoryHint: .notDirectory)
    }

    func upload(
        _ job: ChunkedUploadJob,
        onProgress: @escaping @MainActor (Double) -> Void
    ) async throws -> APIService.MediaUploadResult {
        background?.begin()
        defer { background?.end() }
        if job.size > ChunkedMediaUploader.defaultChunkBytes {
            background?.requestContinuedProcessing()
        }
        let report: @Sendable (Double) -> Void = { [background] fraction in
            Task { @MainActor in
                onProgress(fraction)
                background?.report(fraction)
            }
        }

        return try await withTaskCancellationHandler {
            while true {
                await waitWhileSuspended(job.id)
                if cancelled.contains(job.id) { break }

                let attempt = startAttempt(job, report: report)
                attempts[job.id] = attempt
                do {
                    let data = try await attempt.value
                    attempts[job.id] = nil
                    let result = try JSONDecoder().decode(APIService.MediaUploadResult.self, from: data)
                    discard(job.id)
                    return result
                } catch is CancellationError {
                    attempts[job.id] = nil
                    if cancelled.contains(job.id) { break }
                } catch {
                    attempts[job.id] = nil
                    discard(job.id)
                    throw Self.describe(error)
                }
            }
            discard(job.id)
            throw CancellationError()
        } onCancel: {
            Task { @MainActor in self.cancel(job.id) }
        }
    }

    func suspendForBackground() {
        isSuspended = true
        attempts.values.forEach { $0.cancel() }
    }

    func appDidBecomeActive() {
        isSuspended = false
        wakeWaiters()
    }

    func removeOrphans() {
        guard !hasRemovedOrphans else { return }
        hasRemovedOrphans = true
        let manager = FileManager.default
        let keep = Set(jobs.map(\.localName) + [Self.journalName])
        for name in (try? manager.contentsOfDirectory(atPath: directory.path)) ?? [] where !keep.contains(name) {
            try? manager.removeItem(at: directory.appending(path: name))
        }
        for name in (try? manager.contentsOfDirectory(atPath: temporaryDirectory.path)) ?? []
        where name.hasPrefix("picked-") || name.hasPrefix("upload-") {
            try? manager.removeItem(at: temporaryDirectory.appending(path: name))
        }
    }

    private func startAttempt(_ job: ChunkedUploadJob, report: @escaping @Sendable (Double) -> Void) -> Task<Data, Error> {
        let current = jobs.first { $0.id == job.id } ?? job
        var uploader = ChunkedMediaUploader(transport: transport, makeRequest: requestBuilder(for: current))
        if let sleep { uploader.sleep = sleep }
        let file = fileURL(for: current)
        let scratch = temporaryDirectory.appending(path: "upload-chunk-\(current.id.uuidString)")
        return Task { [uploader, weak self] in
            try await uploader.upload(
                current,
                file: file,
                scratch: scratch,
                onUploadID: { [weak self] id in await self?.record(uploadID: id, for: current.id) },
                onProgress: report
            )
        }
    }

    private func requestBuilder(for job: ChunkedUploadJob) -> ChunkedMediaUploader.RequestBuilder {
        let build = makeRequest
        let account = job.account
        let current = currentAccount
        return { path, method in
            guard await MainActor.run(body: { current() }) == account else {
                throw ChunkedUploadError.server(status: 401, message: "Not paired with server")
            }
            return try await build(path, method)
        }
    }

    private func record(uploadID: String?, for id: UUID) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        jobs[index].serverUploadID = uploadID
        saveJournal()
    }

    private func cancel(_ id: UUID) {
        cancelled.insert(id)
        attempts[id]?.cancel()
        wakeWaiters()
    }

    private func waitWhileSuspended(_ id: UUID) async {
        while isSuspended, !cancelled.contains(id) {
            await withCheckedContinuation { resumeWaiters.append($0) }
        }
    }

    private func wakeWaiters() {
        let waiters = resumeWaiters
        resumeWaiters = []
        waiters.forEach { $0.resume() }
    }

    private func discard(_ id: UUID) {
        if let job = jobs.first(where: { $0.id == id }) {
            try? FileManager.default.removeItem(at: fileURL(for: job))
        }
        jobs.removeAll { $0.id == id }
        claimed.remove(id)
        cancelled.remove(id)
        saveJournal()
    }

    private static func describe(_ error: Error) -> Error {
        ChunkedUploadError.isOutOfSpace(error) ? ChunkedUploadError.insufficientStorage : error
    }

    private func saveJournal() {
        guard let data = try? JSONEncoder().encode(jobs) else { return }
        try? data.write(to: directory.appending(path: Self.journalName), options: .atomic)
    }

    private static func loadJournal(in directory: URL) -> [ChunkedUploadJob] {
        let manager = FileManager.default
        guard let data = try? Data(contentsOf: directory.appending(path: journalName)),
              let saved = try? JSONDecoder().decode([ChunkedUploadJob].self, from: data) else { return [] }
        return saved.filter { manager.fileExists(atPath: directory.appending(path: $0.localName).path) }
    }

    nonisolated static let pairedRequest: ChunkedMediaUploader.RequestBuilder = { path, method in
        try await APIService.shared.mediaUploadRequest(path: path, method: method)
    }

    static func pairedAccount() -> String? {
        guard let pairing = ServerPairing.stored else { return nil }
        return ChunkFile.digest(of: "\(pairing.baseURL)\n\(pairing.bearerToken)")
    }
}

@MainActor
final class UploadBackgroundTime {
    static let shared = UploadBackgroundTime()

    var onOutOfTime: (() -> Void)?

    private var users = 0
    private var assertion = UIBackgroundTaskIdentifier.invalid
    private var continuedTask: BGContinuedProcessingTask?
    private var continuedRequested = false

    private static var continuedIdentifierPrefix: String {
        "\(Bundle.main.bundleIdentifier ?? "com.mason.Journey").media-upload."
    }

    func begin() {
        users += 1
        acquireAssertion()
    }

    func end() {
        users -= 1
        guard users <= 0 else { return }
        users = 0
        continuedRequested = false
        releaseAssertion()
        finishContinuedTask(success: true)
    }

    func appDidBecomeActive() {
        if users > 0 { acquireAssertion() }
    }

    func requestContinuedProcessing() {
        guard !continuedRequested, continuedTask == nil,
              UIApplication.shared.applicationState == .active else { return }
        let identifier = Self.continuedIdentifierPrefix + UUID().uuidString
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { [weak self] task in
            guard let task = task as? BGContinuedProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            task.progress.totalUnitCount = 1000
            let sendable = UncheckedTask(task: task)
            task.expirationHandler = { [weak self] in
                Task { @MainActor in
                    self?.continuedTaskExpired(sendable.task)
                }
            }
            Task { @MainActor in
                self?.adopt(sendable.task)
            }
        }
        guard registered else { return }

        let request = BGContinuedProcessingTaskRequest(
            identifier: identifier,
            title: "Uploading video",
            subtitle: "Journey"
        )
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
            continuedRequested = true
        } catch {
            print("Continued processing unavailable: \(error)")
        }
    }

    func report(_ fraction: Double) {
        continuedTask?.progress.completedUnitCount = Int64(fraction * 1000)
    }

    private func acquireAssertion() {
        guard assertion == .invalid else { return }
        assertion = UIApplication.shared.beginBackgroundTask(withName: "Upload journey media") { [weak self] in
            MainActor.assumeIsolated {
                self?.assertionExpired()
            }
        }
    }

    private func releaseAssertion() {
        guard assertion != .invalid else { return }
        UIApplication.shared.endBackgroundTask(assertion)
        assertion = .invalid
    }

    private func assertionExpired() {
        releaseAssertion()
        if continuedTask == nil { onOutOfTime?() }
    }

    private func adopt(_ task: BGContinuedProcessingTask) {
        continuedRequested = false
        guard users > 0 else {
            task.setTaskCompleted(success: true)
            return
        }
        continuedTask = task
    }

    private func continuedTaskExpired(_ task: BGContinuedProcessingTask) {
        continuedRequested = false
        if continuedTask === task { continuedTask = nil }
        task.setTaskCompleted(success: false)
        if assertion == .invalid { onOutOfTime?() }
    }

    private func finishContinuedTask(success: Bool) {
        continuedTask?.setTaskCompleted(success: success)
        continuedTask = nil
    }
}

nonisolated private struct UncheckedTask: @unchecked Sendable {
    let task: BGContinuedProcessingTask
}
