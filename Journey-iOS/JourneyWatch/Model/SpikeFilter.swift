// Rejects implausible GPS fixes.

import CoreLocation

struct SpikeFilter {
    static let maxAccuracy: CLLocationAccuracy = 50
    static let maxSpeed: CLLocationSpeed = 40

    private static let warmUpFixes = 5
    private static let maxAcceleration = 5.0
    private static let maxSpeedDisagreement = 15.0
    private static let maxFirstFixAge: TimeInterval = 10
    private static let restartGap: TimeInterval = 30

    private var last: CLLocation?
    private var lastSpeed = 0.0
    private var acceptedCount = 0

    mutating func accepts(_ fix: CLLocation, now: Date = .now) -> Bool {
        guard (0...Self.maxAccuracy).contains(fix.horizontalAccuracy) else { return false }

        guard let last else {
            guard now.timeIntervalSince(fix.timestamp) <= Self.maxFirstFixAge else { return false }
            return keep(fix, speed: 0)
        }

        let elapsed = fix.timestamp.timeIntervalSince(last.timestamp)
        guard elapsed > 0 else { return false }

        if elapsed >= Self.restartGap {
            acceptedCount = 0
            return keep(fix, speed: 0)
        }

        let impliedSpeed = fix.distance(from: last) / elapsed
        guard impliedSpeed <= Self.maxSpeed else { return false }

        if acceptedCount >= Self.warmUpFixes {
            let noise = (fix.horizontalAccuracy + last.horizontalAccuracy) / elapsed
            guard impliedSpeed - lastSpeed <= Self.maxAcceleration * elapsed + noise else { return false }
            if fix.speed >= 0, abs(impliedSpeed - fix.speed) > Self.maxSpeedDisagreement + noise { return false }
        }
        return keep(fix, speed: impliedSpeed)
    }

    private mutating func keep(_ fix: CLLocation, speed: Double) -> Bool {
        last = fix
        lastSpeed = speed
        acceptedCount += 1
        return true
    }
}
