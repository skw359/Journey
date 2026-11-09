// Connection to the Apple Watch app.

import Foundation
import WatchConnectivity
import os.log

final class PhoneConnectivityManager: NSObject {
    private nonisolated static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Journey", category: "PhoneConnectivity")

    private let uploadManager: UploadManager

    init(uploadManager: UploadManager) {
        self.uploadManager = uploadManager
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func upload(tripAt file: URL) async {
        uploadManager.enqueue(fileURL: file, source: "watch")
        guard let item = uploadManager.queue.first(where: { $0.fileName == file.lastPathComponent }) else { return }
        let saved = await uploadManager.upload(item: item)
        Self.reportResult(tripId: item.tripId, ok: saved)
    }

    private nonisolated static func reportResult(tripId: String, ok: Bool) {
        guard WCSession.default.isReachable else { return }
        WCSession.default.sendMessage(["type": "uploadResult", "tripId": tripId, "ok": ok], replyHandler: nil) { error in
            log.error("Couldn't report the upload result to the watch: \(error.localizedDescription)")
        }
    }
}

extension PhoneConnectivityManager: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: (any Error)?) {
        if let error { Self.log.error("WCSession activation failed: \(error.localizedDescription)") }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        replyHandler([:])
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {}

    nonisolated func session(_ session: WCSession, didReceive file: WCSessionFile) {
        let name = file.fileURL.lastPathComponent
        let destination = URL.documentsDirectory.appending(path: name)
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: file.fileURL, to: destination)
        } catch {
            Self.log.error("Couldn't save \(name) from the watch: \(error.localizedDescription)")
            return
        }
        Task { @MainActor in await self.upload(tripAt: destination) }
    }
}
