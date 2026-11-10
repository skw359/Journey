// Persistent queue of file uploads with retry.

import Foundation
import Network

@Observable
final class UploadManager {
    var queue: [UploadQueueItem] = []
    private let queueFileName = "upload_queue.json"
    private var isRetrying = false
    private var pathMonitor: NWPathMonitor?
    private var wasOnline = true

    init() {
        loadQueue()
    }

    func enqueue(fileURL: URL, source: String) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let fileName = fileURL.lastPathComponent
        let destURL = docs.appendingPathComponent(fileName)

        if fileURL != destURL {
            try? FileManager.default.copyItem(at: fileURL, to: destURL)
        }

        let item = UploadQueueItem(
            id: UUID(),
            fileName: fileName,
            fileRelativePath: fileName,
            source: source,
            createdAt: Date(),
            status: .queued
        )
        queue.insert(item, at: 0)
        saveQueue()
    }

    func upload(item: UploadQueueItem) async -> Bool {
        guard let index = queue.firstIndex(where: { $0.id == item.id }) else { return false }
        queue[index].status = .uploading
        saveQueue()

        do {
            let response = try await APIService.shared.uploadJourney(
                fileURL: item.fileURL,
                source: item.source,
                recordingId: item.id.uuidString
            )
            try? FileManager.default.removeItem(at: item.fileURL)

            queue.removeAll { $0.id == item.id }
            saveQueue()

            return response.saved ?? false
        } catch {
            if let idx = queue.firstIndex(where: { $0.id == item.id }) {
                queue[idx].status = .failed(error.localizedDescription)
                queue[idx].retriesAutomatically = Self.isWorthRetrying(error)
                saveQueue()
            }
            return false
        }
    }

    /// No signal, a server that's down or a token the phone can't read yet are passing; a
    /// file the server refuses as malformed or too large will be refused again.
    private static func isWorthRetrying(_ error: Error) -> Bool {
        if case APIError.httpError(let status) = error, [400, 413, 415, 422].contains(status) {
            return false
        }
        return true
    }

    /// Sends what is waiting, without anyone having to open Settings: called at launch, when
    /// the app comes to the front and when the network comes back. Items the server refused
    /// are left for a manual retry.
    func retryPending() async {
        guard !isRetrying, ServerPairing.stored != nil else { return }
        isRetrying = true
        defer { isRetrying = false }
        let waiting = queue.filter { item in
            switch item.status {
            case .queued: return true
            case .failed: return item.retriesAutomatically != false
            default: return false
            }
        }
        for item in waiting {
            _ = await upload(item: item)
        }
    }

    /// Queues recordings that were interrupted or never queued (see RecordingFiles.leftovers).
    /// Call before anything starts recording, or pass the CSV being written as `active`.
    func recoverLeftoverRecordings(active: URL? = nil) {
        let known = Set(queue.map(\.fileName))
        for url in RecordingFiles.leftovers(active: active, known: known) {
            enqueue(fileURL: url, source: "iphone")
        }
    }

    func startRetryingWhenOnline() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { @Sendable [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let cameBack = online && !self.wasOnline
                self.wasOnline = online
                if cameBack { await self.retryPending() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "Journey.UploadManager.network"))
        pathMonitor = monitor
    }

    func uploadAll() async {
        let queuedItems = queue.filter {
            if case .queued = $0.status { return true }
            if case .failed = $0.status { return true }
            return false
        }
        for item in queuedItems {
            _ = await upload(item: item)
        }
    }

    func retryFailed() async {
        let failedItems = queue.filter {
            if case .failed = $0.status { return true }
            return false
        }
        for item in failedItems {
            if let index = queue.firstIndex(where: { $0.id == item.id }) {
                queue[index].status = .queued
                queue[index].retriesAutomatically = true
            }
        }
        saveQueue()
        await uploadAll()
    }

    func remove(item: UploadQueueItem) {
        try? FileManager.default.removeItem(at: item.fileURL)
        queue.removeAll { $0.id == item.id }
        saveQueue()
    }

    func clearCompleted() {
        queue.removeAll {
            if case .complete = $0.status { return true }
            return false
        }
        saveQueue()
    }

    private var queueFileURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent(queueFileName)
    }

    private func loadQueue() {
        guard let data = try? Data(contentsOf: queueFileURL),
              let items = try? JSONDecoder().decode([UploadQueueItem].self, from: data) else { return }
        // An item whose file is gone can never upload. (This used to drop any failure whose
        // message contained "201", which could delete a recording that was never uploaded.)
        let present = items.filter { FileManager.default.fileExists(atPath: $0.fileURL.path) }

        queue = present.map { item in
            var item = item
            if case .uploading = item.status {
                item.status = .queued
            }
            return item
        }
    }

    private func saveQueue() {
        guard let data = try? JSONEncoder().encode(queue) else { return }
        try? data.write(to: queueFileURL, options: .atomic)
    }
}
