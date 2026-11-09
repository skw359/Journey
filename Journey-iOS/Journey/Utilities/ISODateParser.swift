// Parses ISO 8601 dates.

import Foundation

enum ISODateParser {
    private static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let withoutFractionalSeconds = ISO8601DateFormatter()

    private static var parsed: [String: Date?] = [:]

    static func date(from string: String) -> Date? {
        if let known = parsed[string] { return known }
        let date = withFractionalSeconds.date(from: string) ?? withoutFractionalSeconds.date(from: string)
        parsed[string] = .some(date)
        return date
    }
}
