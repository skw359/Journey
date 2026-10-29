// WatchFeedbackManager.swift (watch target)
import Foundation
import WatchConnectivity
import Combine
import WatchKit

final class WatchFeedbackManager: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchFeedbackManager()

    enum State: Equatable {
        case idle
        case pending   // user tapped Stop; waiting for phone
        case success
        case failure(String?)
    }

    @Published var state: State = .idle
    @Published var lastTripId: String?

    private override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    // Call when user taps Stop
    func beginPending(for tripId: String) {
        lastTripId = tripId
        state = .pending
    }

    // MARK: - WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        guard
            let type = message["type"] as? String, type == "uploadResult",
            let tripId = message["tripId"] as? String,
            tripId == lastTripId // only react to *our* trip
        else { return }

        if let ok = message["ok"] as? Bool, ok == true {
            state = .success
            WKInterfaceDevice.current().play(.success)
        } else {
            let reason = message["reason"] as? String
            state = .failure(reason)
            WKInterfaceDevice.current().play(.failure)
        }

        // Auto-dismiss after 2 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.state = .idle
        }
    }
}
