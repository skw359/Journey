import Foundation
import WatchConnectivity

@Observable
final class PhoneConnectivityManager: NSObject {
    var isWatchConnected = false
    var watchRecordingState: String = "idle"
    var watchPointCount: Int = 0
    var watchDuration: Int = 0

    private var uploadManager: UploadManager?
    private var session: WCSession?

    override init() {
        super.init()
        if WCSession.isSupported() {
            session = WCSession.default
            session?.delegate = self
            session?.activate()
        }
    }

    func configure(uploadManager: UploadManager) {
        self.uploadManager = uploadManager
    }

    func sendUploadResult(tripId: String, ok: Bool, reason: String? = nil) {
        var message: [String: Any] = [
            "type": "uploadResult",
            "tripId": tripId,
            "ok": ok
        ]
        if let reason { message["reason"] = reason }

        session?.sendMessage(message, replyHandler: nil, errorHandler: { error in
            print("Failed to send upload result to watch: \(error)")
        })
    }
}

extension PhoneConnectivityManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isWatchConnected = session.isReachable
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate for new watch pairing
        session.activate()
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isWatchConnected = session.isReachable
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async {
            if message["ping"] as? String == "1" {
                // Keep-alive ping, no action needed
                return
            }
            if let status = message["status"] as? String {
                if status == "recording_started" {
                    self.watchRecordingState = "recording"
                } else if status == "recording_stopped" {
                    self.watchRecordingState = "idle"
                }
            }
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        if message["ping"] as? String == "1" {
            replyHandler(["pong": "1"])
        }
        // Also process as regular message
        self.session(session, didReceiveMessage: message)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async {
            if let state = applicationContext["watch_state"] as? String {
                self.watchRecordingState = state
            }
            if let points = applicationContext["point_count"] as? Int {
                self.watchPointCount = points
            }
            if let dur = applicationContext["duration_sec"] as? Int {
                self.watchDuration = dur
            }
        }
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // Received ZIP file from watch - save and enqueue for upload
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let fileName = file.fileURL.lastPathComponent
        let destURL = docs.appendingPathComponent(fileName)

        do {
            try? FileManager.default.removeItem(at: destURL)
            try FileManager.default.moveItem(at: file.fileURL, to: destURL)

            DispatchQueue.main.async {
                self.uploadManager?.enqueue(fileURL: destURL, source: "watch")

                // Extract tripId from filename
                let tripId = fileName
                    .replacingOccurrences(of: "route_", with: "")
                    .replacingOccurrences(of: ".zip", with: "")

                // Upload immediately
                Task {
                    if let item = self.uploadManager?.queue.first(where: { $0.fileName == fileName }) {
                        let success = await self.uploadManager?.upload(item: item) ?? false
                        self.sendUploadResult(tripId: tripId, ok: success, reason: success ? nil : "Upload failed")
                    }
                }
            }
        } catch {
            print("Failed to save watch file: \(error)")
        }
    }
}
