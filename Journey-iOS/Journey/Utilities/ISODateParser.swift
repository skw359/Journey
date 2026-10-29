import Foundation

enum ISODateParser {
    private static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let withoutFractionalSeconds = ISO8601DateFormatter()

    /// Parses server timestamps with or without milliseconds, e.g. "2026-04-14T16:12:00.000Z"
    static func date(from string: String) -> Date? {
        withFractionalSeconds.date(from: string) ?? withoutFractionalSeconds.date(from: string)
    }
}
