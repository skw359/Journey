// Queued upload and its status.

import Foundation

enum UploadStatus: Codable, Equatable {
    case queued
    case uploading
    case complete
    case failed(String)
}

struct UploadQueueItem: Codable, Identifiable, Equatable {
    let id: UUID
    let fileName: String
    let fileRelativePath: String
    let source: String
    let createdAt: Date
    var status: UploadStatus
    /// False after a failure that trying again won't fix (the server refused the file). Such
    /// items wait for a manual retry. Absent in queues saved by older versions.
    var retriesAutomatically: Bool? = true

    var fileURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent(fileRelativePath)
    }

    var tripId: String {
        fileName.replacingOccurrences(of: "route_", with: "")
                .replacingOccurrences(of: ".zip", with: "")
    }

    var statusText: String {
        switch status {
        case .queued: return "Queued"
        case .uploading: return "Uploading..."
        case .complete: return "Complete"
        case .failed(let reason): return "Failed: \(reason)"
        }
    }
}
