// Connection to the iPhone app.

import WatchConnectivity
import WatchKit

final class PhoneLink: NSObject {
    static let shared = PhoneLink()

    private static let freshness: TimeInterval = 90

    private let session = WCSession.default
    private var lastSeen: Date?

    var isConnected: Bool {
        session.isReachable || lastSeen.map { Date.now.timeIntervalSince($0) < Self.freshness } ?? false
    }

    func activate() {
        session.delegate = self
        session.activate()
    }

    func send(status: String) {
        send(["status": status])
    }

    func updateContext(state: String, points: Int, waypoints: Int, duration: TimeInterval) {
        try? session.updateApplicationContext([
            "watch_state": state,
            "point_count": points,
            "waypoint_count": waypoints,
            "duration_sec": Int(duration),
            "ts": Date.now.timeIntervalSince1970
        ])
    }

    func transfer(_ file: URL) {
        session.transferFile(file, metadata: nil)
    }

    private func send(_ message: [String: Any]) {
        guard session.isReachable else { return }
        session.sendMessage(message, replyHandler: { @Sendable [weak self] _ in
            self?.markSeen()
        }, errorHandler: { @Sendable _ in })
    }

    private nonisolated func markSeen() {
        Task { @MainActor [weak self] in self?.lastSeen = .now }
    }
}

extension PhoneLink: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: (any Error)?) {
        Task { @MainActor [weak self] in self?.send(["ping": "1"]) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        markSeen()
        guard message["type"] as? String == "uploadResult" else { return }
        let succeeded = message["ok"] as? Bool == true
        Task { @MainActor in WKInterfaceDevice.current().play(succeeded ? .success : .failure) }
    }

    nonisolated func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: (any Error)?) {
        guard error == nil else { return }
        try? FileManager.default.removeItem(at: fileTransfer.file.fileURL)
    }
}
