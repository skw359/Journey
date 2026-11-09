// Detects the figure-8 motion that confirms a calibration.

import CoreMotion
import Observation

@Observable
final class FigureEightDetector {
    private static let minRotationRate = 1.0
    private static let requiredDirectionChanges = 3
    private static let maxPause: TimeInterval = 3.5

    private(set) var isConfirmed = false
    private let motion = CMMotionManager()
    private var lastDirectionWasPositive: Bool?
    private var directionChanges = 0
    private var lastMotion: Date?

    func start() {
        motion.deviceMotionUpdateInterval = 0.1
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let rate = data?.rotationRate else { return }
            MainActor.assumeIsolated { self?.process(rate) }
        }
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
    }

    private func process(_ rate: CMRotationRate) {
        let strongest = [rate.x, rate.y, rate.z].max { abs($0) < abs($1) } ?? 0

        guard abs(strongest) > Self.minRotationRate else {
            if let lastMotion, Date.now.timeIntervalSince(lastMotion) > Self.maxPause { reset() }
            return
        }

        lastMotion = .now
        if let lastDirectionWasPositive, lastDirectionWasPositive != (strongest > 0) { directionChanges += 1 }
        lastDirectionWasPositive = strongest > 0
        if directionChanges >= Self.requiredDirectionChanges { isConfirmed = true }
    }

    private func reset() {
        isConfirmed = false
        lastDirectionWasPositive = nil
        directionChanges = 0
        lastMotion = nil
    }
}
