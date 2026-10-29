import Foundation

struct JourneySummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String?
    let date: String?
    let startTime: String?
    let endTime: String?
    let distance: String?
    let duration: String?
    let watchRecorded: Bool?
    let waypointCount: Int?
    let photoCount: Int?
    /// The first converted photo or video poster, as the server picks it for list cards.
    let coverPhoto: String?
    let travelMode: String?
    let avgSpeed: String?
    let citiesPassed: [String]?
    let placesPassed: [String]?

    var distanceDouble: Double {
        Double(distance ?? "0") ?? 0
    }

    var avgSpeedDouble: Double {
        Double(avgSpeed ?? "0") ?? 0
    }

    var startDate: Date? {
        guard let startTime else { return nil }
        return ISODateParser.date(from: startTime)
    }

    var endDate: Date? {
        guard let endTime else { return nil }
        return ISODateParser.date(from: endTime)
    }

    // Shared because creating a DateFormatter is slow, and these run for every journey
    // each time the list renders
    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let sectionFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM d, yyyy"
        return formatter
    }()

    var timeRangeString: String {
        var parts: [String] = []
        if let start = startDate {
            parts.append(Self.timeFormatter.string(from: start))
        }
        if let end = endDate {
            parts.append(Self.timeFormatter.string(from: end))
        }
        return parts.joined(separator: " - ")
    }

    var displayName: String {
        name ?? "Journey"
    }

    var subtitleString: String {
        var parts: [String] = []
        let range = timeRangeString
        if !range.isEmpty { parts.append(range) }
        if let duration { parts.append(duration) }
        return parts.joined(separator: " \u{2022} ")
    }

    var sectionDate: String {
        guard let startDate else { return "Unknown Date" }
        return Self.sectionFormatter.string(from: startDate).uppercased()
    }
}
