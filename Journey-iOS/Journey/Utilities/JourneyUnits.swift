import Foundation

enum JourneyUnits {
    static func distance(fromMiles miles: Double, useMetric: Bool) -> Double {
        useMetric ? miles * 1.609344 : miles
    }

    static func distanceUnit(useMetric: Bool) -> String {
        useMetric ? "km" : "mi"
    }

    static func speed(fromMph mph: Double, useMetric: Bool) -> Double {
        useMetric ? mph * 1.609344 : mph
    }

    static func speedUnit(useMetric: Bool) -> String {
        useMetric ? "km/h" : "mph"
    }

    static func elevation(fromMeters meters: Double, useMetric: Bool) -> Double {
        useMetric ? meters : meters * 3.28084
    }

    static func elevationUnit(useMetric: Bool) -> String {
        useMetric ? "m" : "ft"
    }

    static func acceleration(speedDeltaMph: Double, durationSeconds: Double, useMetric: Bool) -> Double {
        guard durationSeconds > 0 else { return 0 }
        let speedDeltaPerSecond = speedDeltaMph * (useMetric ? 0.44704 : 1.46667)
        return speedDeltaPerSecond / durationSeconds
    }

    static func accelerationUnit(useMetric: Bool) -> String {
        useMetric ? "m/s²" : "ft/s²"
    }
}
