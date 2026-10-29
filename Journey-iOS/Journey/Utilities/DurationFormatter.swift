import Foundation

enum DurationFormatter {
    /// Formats seconds into display string: "0:00", "0:59", "1:00", "59:59", "1:00:00"
    static func format(_ totalSeconds: Int) -> String {
        let clampedSeconds = max(0, totalSeconds)
        let hours = clampedSeconds / 3600
        let minutes = (clampedSeconds % 3600) / 60
        let seconds = clampedSeconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
    }

    /// Formats seconds into "0h 8m" style for journey list
    static func formatCompact(_ totalSeconds: Int) -> String {
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        return "\(hours)h \(minutes)m"
    }

    /// Formats a "0h 22m" style duration as "22 min" or "1 hr 5 min"
    static func formatReadable(compact duration: String?) -> String {
        guard let duration else { return "\u{2014}" }
        let seconds = parseCompact(duration)
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 {
            return "\(hours) hr \(minutes) min"
        }
        return "\(minutes) min"
    }

    /// Parses duration string like "0h 22m" into total seconds
    static func parseCompact(_ duration: String) -> Int {
        var hours = 0
        var minutes = 0
        let components = duration.lowercased()
            .replacingOccurrences(of: "h", with: " ")
            .replacingOccurrences(of: "m", with: " ")
            .split(separator: " ")
            .compactMap { Int($0) }
        if components.count >= 2 {
            hours = components[0]
            minutes = components[1]
        } else if components.count == 1 {
            minutes = components[0]
        }
        return hours * 3600 + minutes * 60
    }
}
