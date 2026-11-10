// Connection to the iPhone app.

import WatchConnectivity
import WatchKit

final class PhoneLink: NSObject {
    static let shared = PhoneLink()

    private static let freshness: TimeInterval = 90
    private static let retryDelay: Duration = .seconds(60)

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
        let inFlight = session.outstandingFileTransfers.contains { $0.file.fileURL.lastPathComponent == file.lastPathComponent }
        guard !inFlight, FileManager.default.fileExists(atPath: file.path) else { return }
        session.transferFile(file, metadata: nil)
    }

    /// Sends trips that never reached the phone: leftovers from before this launch.
    func sendLeftovers() {
        guard session.activationState == .activated else { return }
        for file in RouteLog.leftovers() { transfer(file) }
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
        Task { @MainActor [weak self] in
            self?.send(["ping": "1"])
            // At launch nothing is recording yet, so any CSV left is an interrupted trip.
            self?.sendLeftovers()
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        markSeen()
        guard message["type"] as? String == "uploadResult" else { return }
        let succeeded = message["ok"] as? Bool == true
        Task { @MainActor in WKInterfaceDevice.current().play(succeeded ? .success : .failure) }
    }

    nonisolated func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: (any Error)?) {
        let file = fileTransfer.file.fileURL
        guard error != nil else {
            try? FileManager.default.removeItem(at: file)
            return
        }
        // The zip is still here; try again in a while (and at the next launch regardless).
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.retryDelay)
            self?.transfer(file)
        }
    }
}
