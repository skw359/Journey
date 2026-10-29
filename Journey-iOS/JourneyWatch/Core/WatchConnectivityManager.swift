// WatchConnectivityManager.swift
import Foundation
import WatchConnectivity
import Combine

final class WatchConnectivityManager: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchConnectivityManager()

    @Published var isConnected: Bool = false
    @Published var lastSeenPhone: Date?

    // NEW: how long we consider the phone "recently seen"
    private let freshness: TimeInterval = 90
    private var decayTimer: Timer?

    private override init() {
        super.init()
        activate()
    }

    private func activate() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
    }

    // MARK: - Public helpers
    func updateContext(_ ctx: [String: Any]) {
        guard WCSession.isSupported() else { return }
        do {
            try WCSession.default.updateApplicationContext(ctx)
            touch()           // ✅ counts as a healthy sighting of the phone
        } catch {
            print("WC updateApplicationContext error:", error.localizedDescription)
        }
        refreshConnectivity()
    }

    func transferFile(_ url: URL) {
        WCSession.default.transferFile(url, metadata: nil)
        refreshConnectivity()
    }

    func sendMessage(_ msg: [String: Any]) {
        guard WCSession.default.isReachable else { refreshConnectivity(); return }
        WCSession.default.sendMessage(msg, replyHandler: { _ in
            self.touch()
            self.refreshConnectivity()
        }, errorHandler: { _ in
            self.refreshConnectivity()
        })
    }

    func pingPhone() {
        guard WCSession.default.isReachable else { refreshConnectivity(); return }
        WCSession.default.sendMessage(["ping":"1"], replyHandler: { _ in
            self.touch()
            self.refreshConnectivity()
        }, errorHandler: { _ in
            self.refreshConnectivity()
        })
    }

    // MARK: - WCSessionDelegate
    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        refreshConnectivity()
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        refreshConnectivity()
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        touch()
        refreshConnectivity()
    }

    // MARK: - Connectivity derivation
    private func refreshConnectivity() {
        let s = WCSession.default

        // NEW: We consider "connected" only if:
        // 1) immediate reachability (realtime) OR
        // 2) we saw the phone recently (within freshness window)
        let reachable = s.isReachable
        let recentlySeen = {
            guard let t = self.lastSeenPhone else { return false }
            return Date().timeIntervalSince(t) < self.freshness
        }()

        let ok = reachable || recentlySeen

        DispatchQueue.main.async {
            self.isConnected = ok
        }
    }

    private func touch() {
        DispatchQueue.main.async {
            self.lastSeenPhone = Date()

            // NEW: schedule a decay so status auto-downgrades after freshness
            self.decayTimer?.invalidate()
            self.decayTimer = Timer.scheduledTimer(withTimeInterval: self.freshness,
                                                   repeats: false) { [weak self] _ in
                self?.refreshConnectivity()
            }
        }
    }
}
