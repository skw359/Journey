import Foundation

@Observable
final class UploadManager {
    var queue: [UploadQueueItem] = []
    private let queueFileName = "upload_queue.json"

    init() {
        loadQueue()
    }

    func enqueue(fileURL: URL, source: String) {
        // Copy file to documents if not already there
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
                source: item.source
            )
            // Clean up file after successful upload
            try? FileManager.default.removeItem(at: item.fileURL)

            // Remove completed upload from queue to prevent duplicates
            queue.removeAll { $0.id == item.id }
            saveQueue()

            return response.saved ?? false
        } catch {
            if let idx = queue.firstIndex(where: { $0.id == item.id }) {
                queue[idx].status = .failed(error.localizedDescription)
                saveQueue()
            }
            return false
        }
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

    // MARK: - Persistence

    private var queueFileURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent(queueFileName)
    }

    private func loadQueue() {
        guard let data = try? Data(contentsOf: queueFileURL),
              let items = try? JSONDecoder().decode([UploadQueueItem].self, from: data) else { return }
        // Remove items that "failed" with HTTP 201 — those actually succeeded
        let cleaned = items.filter { item in
            if case .failed(let msg) = item.status, msg.contains("201") {
                try? FileManager.default.removeItem(at: item.fileURL)
                return false
            }
            return true
        }

        // Reset any "uploading" items to "queued" (interrupted uploads)
        queue = cleaned.map { item in
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
