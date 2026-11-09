// Formats distances, speeds, elevations and times for display.

import Foundation

enum Format {
    private static let feetPerTenthOfMile = 528.0
    private static let feetPerMile = 5280.0

    static func miles(_ meters: Double, precise: Bool) -> String {
        String(format: precise ? "%.2f" : "%.1f", meters / Units.metersPerMile)
    }

    static func speed(_ mph: Double, precise: Bool) -> String {
        if precise { return String(format: "%.2f", mph) }
        return String(format: mph > 20 ? "%.0f" : "%.1f", mph)
    }

    static func whole(_ value: Double) -> String {
        String(format: "%.0f", value)
    }

    static func elevation(_ meters: Double?) -> String {
        guard let meters else { return "— ft" }
        return "\(Int((meters * Units.feetPerMeter).rounded()).formatted()) ft"
    }

    static func clock(_ time: TimeInterval) -> String {
        let seconds = Int(time)
        let hours = seconds / 3600
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, seconds / 60 % 60, seconds % 60)
            : String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    static func speedgoalTime(_ time: TimeInterval, showingHours: Bool = false) -> String {
        let hundredths = Int(max(time, 0) * 100)
        let hours = hundredths / 360_000
        let minutes = hundredths / 6000 % 60
        let seconds = hundredths / 100 % 60
        return showingHours || hours > 0
            ? String(format: "%d:%02d:%02d.%02d", hours, minutes, seconds, hundredths % 100)
            : String(format: "%02d:%02d.%02d", minutes, seconds, hundredths % 100)
    }

    static func waypointDistance(feet: Double) -> String {
        feet < feetPerTenthOfMile
            ? "\(Int(feet.rounded())) ft"
            : String(format: "%.1f mi", feet / feetPerMile)
    }
}
