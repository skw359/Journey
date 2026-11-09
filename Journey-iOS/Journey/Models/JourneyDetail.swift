// Full journey data decoded from the server.

import Foundation
import CoreLocation

struct JourneyDetail: Codable {
    let id: String
    let name: String?
    let date: String?
    let distance: String?
    let duration: String?
    let topSpeed: String?
    let avgSpeed: String?
    let topElevation: String?
    let lowestElevation: String?
    let avgElevation: String?
    let startTime: String?
    let endTime: String?
    let coordinates: [[Double]]?
    let elevationGain: Double?
    let elevationLoss: Double?
    let startCoord: [Double]?
    let endCoord: [Double]?
    let source: String?
    let watchRecorded: Bool?
    let profileTimeMs: [Double]?
    let profileDistMi: [Double]?
    let profileElevM: [Double?]?
    let profileSpeedMph: [Double]?
    let travelMode: String?
    let waypoints: [JourneyWaypoint]?
    var photos: [JourneyPhoto]?
    let weather: JourneyWeather?

    var viewableMedia: [JourneyPhoto] {
        (photos ?? []).filter { $0.isViewable }
    }

    var previewFilenames: [String] {
        viewableMedia.compactMap(\.previewFilename)
    }

    var coverFilename: String? {
        previewFilenames.first
    }

    var distanceDouble: Double { Double(distance ?? "0") ?? 0 }
    var topSpeedDouble: Double { Double(topSpeed ?? "0") ?? 0 }
    var avgSpeedDouble: Double { Double(avgSpeed ?? "0") ?? 0 }
    var topElevationDouble: Double { Double(topElevation ?? "0") ?? 0 }

    var routeCoordinates: [CLLocationCoordinate2D] {
        (coordinates ?? []).compactMap { arr -> CLLocationCoordinate2D? in
            guard arr.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: arr[0], longitude: arr[1])
        }
    }

    var startDate: Date? {
        guard let startTime else { return nil }
        return ISODateParser.date(from: startTime)
    }

    var endDate: Date? {
        guard let endTime else { return nil }
        return ISODateParser.date(from: endTime)
    }

    var capturedDateRange: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM d, yyyy - HH:mm"
        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "HH:mm"
        var result = ""
        if let start = startDate {
            result += formatter.string(from: start)
        }
        if let end = endDate {
            result += " - " + timeFormatter.string(from: end)
        }
        return result
    }
}

struct JourneyWaypoint: Codable {
    let id: String
    let lat: Double?
    let lon: Double?
    let timestamp: Double?
    let note: String?
    let elevation: Double?
    let label: String?
}

struct JourneyPhoto: Codable, Equatable {
    let id: String
    let filename: String?
    let originalName: String?
    let mimetype: String?
    let size: Int?
    let uploadedAt: String?
    let kind: String?
    let status: String?
    let posterFilename: String?
    let durationMs: Int?
    let width: Int?
    let height: Int?

    var isVideo: Bool { kind == "video" }
    var isProcessing: Bool { status == "processing" }
    var isFailed: Bool { status == "failed" }

    var isViewable: Bool {
        (status ?? "ready") == "ready" && !(filename ?? "").isEmpty
    }

    var previewFilename: String? {
        guard isViewable else { return nil }
        return isVideo ? posterFilename : filename
    }

    var durationText: String? {
        guard let durationMs, durationMs > 0 else { return nil }
        let total = Int((Double(durationMs) / 1000).rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }

    static func describeCounts(photos: Int, videos: Int) -> String {
        var parts: [String] = []
        if photos > 0 || videos == 0 { parts.append("\(photos) photo\(photos == 1 ? "" : "s")") }
        if videos > 0 { parts.append("\(videos) video\(videos == 1 ? "" : "s")") }
        return parts.joined(separator: " and ")
    }
}

struct JourneyWeather: Codable {
    let temp: Double?
    let feelsLike: Double?
    let humidity: Int?
    let windSpeed: Double?
    let condition: String?
    let description: String?
    let icon: String?
}
