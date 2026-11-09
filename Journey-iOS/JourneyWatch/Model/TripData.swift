// Value types and helpers for trip data, units, graph history and stillness.

import CoreLocation

enum Units {
    static let mphPerMetersPerSecond = 2.23694
    static let feetPerMeter = 3.28084
    static let metersPerMile = 1609.344
}

struct Trip: Hashable {
    let miles: Double
    let topSpeed: Double
    let averageSpeed: Double
    let duration: TimeInterval
    let highElevation: Double?
    let lowElevation: Double?
    let speedSamples: [Sample]
    let elevationSamples: [Sample]
}

struct Sample: Hashable {
    let time: Date
    let value: Double
}

struct Place {
    var name = ""
    var county = ""
}

struct Series {
    private static let capacity = 200
    private static let sampleInterval: TimeInterval = 10

    let minChange: Double
    private(set) var low: Double?
    private(set) var high: Double?
    private var points: [Sample] = []
    private var latest: Sample?
    private var lastSampled: Sample?
    private var keepEvery = 1
    private var sinceKept = 0

    init(minChange: Double) {
        self.minChange = minChange
    }

    mutating func record(_ value: Double, at time: Date) {
        low = min(low ?? value, value)
        high = max(high ?? value, value)

        let sample = Sample(time: time, value: value)
        latest = sample
        if let lastSampled,
           time.timeIntervalSince(lastSampled.time) < Self.sampleInterval,
           abs(value - lastSampled.value) < minChange { return }
        lastSampled = sample

        sinceKept += 1
        guard sinceKept >= keepEvery else { return }
        sinceKept = 0
        points.append(sample)

        guard points.count >= Self.capacity else { return }
        points = stride(from: 0, to: points.count, by: 2).map { points[$0] }
        keepEvery *= 2
    }

    func samples(limit: Int = 100) -> [Sample] {
        let count = min(points.count, limit - 1)
        var result = (0..<count).map { points[$0 * points.count / count] }
        if let latest, result.last != latest { result.append(latest) }
        return result
    }
}

struct Speedgoal {
    private static let timerStartSpeed = 2.0

    let target: Int
    private(set) var startedAt: TimeInterval?
    private(set) var hitAfter: TimeInterval?

    init(target: Int) {
        self.target = target
    }

    mutating func update(mph: Double, at clock: TimeInterval) -> Bool {
        guard hitAfter == nil else { return false }
        if startedAt == nil, mph >= Self.timerStartSpeed { startedAt = clock }
        guard mph >= Double(target) else { return false }
        hitAfter = clock - (startedAt ?? clock)
        return true
    }
}

struct StillnessDetector {
    private static let maxSpeed = 0.3
    private static let maxMovement: CLLocationDistance = 5
    private static let duration: TimeInterval = 60
    private static let speedSmoothing = 0.2

    private var anchor: CLLocation?
    private var smoothedSpeed = 0.0

    mutating func isStill(after fix: CLLocation) -> Bool {
        smoothedSpeed += (max(fix.speed, 0) - smoothedSpeed) * Self.speedSmoothing
        guard let anchor, smoothedSpeed <= Self.maxSpeed, fix.distance(from: anchor) <= Self.maxMovement else {
            anchor = fix
            return false
        }
        return fix.timestamp.timeIntervalSince(anchor.timestamp) >= Self.duration
    }
}

struct TripProgress {
    var filter = SpikeFilter()
    var stillness = StillnessDetector()
    var lastFix: CLLocation?
    var lastSignal = Date.now
    var movingTime: TimeInterval = 0
    var topSpeed = 0.0
    var speedHistory = Series(minChange: 5)
    var elevationHistory = Series(minChange: 5)
    var pausedTime: TimeInterval = 0
    var pauseBegan: Date?
    var waypointFixes: [CLLocation] = []
    var sentModerateAlert = false
    var sentHighAlert = false
}

extension CLLocation {
    func bearing(to destination: CLLocation) -> Double {
        let fromLatitude = coordinate.latitude * .pi / 180
        let toLatitude = destination.coordinate.latitude * .pi / 180
        let longitudeDelta = (destination.coordinate.longitude - coordinate.longitude) * .pi / 180
        let east = sin(longitudeDelta) * cos(toLatitude)
        let north = cos(fromLatitude) * sin(toLatitude) - sin(fromLatitude) * cos(toLatitude) * cos(longitudeDelta)
        return atan2(east, north) * 180 / .pi
    }

    static func weightedAverage(of fixes: [CLLocation]) -> CLLocation {
        let weights = fixes.map { 1 / max($0.horizontalAccuracy, 1) }
        let total = weights.reduce(0, +)
        let weighted = { (value: (CLLocation) -> Double) in
            zip(fixes, weights).reduce(0) { $0 + value($1.0) * $1.1 } / total
        }
        return CLLocation(latitude: weighted { $0.coordinate.latitude },
                          longitude: weighted { $0.coordinate.longitude })
    }
}
