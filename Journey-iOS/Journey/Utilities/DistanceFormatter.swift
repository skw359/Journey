import Foundation

enum DistanceFormatter {
    /// Formats distance for display: 0.00, 0.01, 0.5, 5.2, 100, 1,000
    static func format(_ miles: Double, useMetric: Bool = false) -> String {
        formatValue(value(fromMiles: miles, useMetric: useMetric))
    }

    static func value(fromMiles miles: Double, useMetric: Bool) -> Double {
        JourneyUnits.distance(fromMiles: miles, useMetric: useMetric)
    }

    static func unit(useMetric: Bool) -> String {
        JourneyUnits.distanceUnit(useMetric: useMetric)
    }

    private static func formatValue(_ distance: Double) -> String {
        let distance = max(0, distance)
        if distance < 0.01 {
            return String(format: "%.2f", distance)
        } else if distance < 0.1 {
            return String(format: "%.2f", distance)
        } else if distance < 1.0 {
            return String(format: "%.1f", distance)
        } else if distance < 10 {
            return String(format: "%.1f", distance)
        } else if distance < 100 {
            return String(format: "%.0f", distance)
        } else {
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            formatter.maximumFractionDigits = 0
            return formatter.string(from: NSNumber(value: distance)) ?? "\(Int(distance))"
        }
    }
}
