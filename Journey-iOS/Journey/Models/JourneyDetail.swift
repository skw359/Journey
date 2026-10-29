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
    let profileElevM: [Double]?
    let profileSpeedMph: [Double]?
    let travelMode: String?
    let waypoints: [JourneyWaypoint]?
    /// The journey's photos and videos, in upload order (the order the server returns).
    /// Variable so uploads and deletes can update a loaded journey without refetching it.
    var photos: [JourneyPhoto]?
    let weather: JourneyWeather?

    /// Photos and videos the server has finished converting, in upload order.
    var viewableMedia: [JourneyPhoto] {
        (photos ?? []).filter { $0.isViewable }
    }

    /// Images that represent the viewable media: each photo, or a converted video's poster.
    var previewFilenames: [String] {
        viewableMedia.compactMap(\.previewFilename)
    }

    /// Matches the server's journey cover (`coverPhoto` in the journey list): the first item
    /// in upload order that has a preview image.
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

/// A photo or video on a journey. The server keeps both in a journey's `photos`, telling them
/// apart by `kind`. HEIC photos and videos are stored as uploaded with `status` "processing",
/// then converted in the background (HEIC to JPEG, video to an H.264 MP4 with a poster
/// image), which gives them a new `filename` and the status "ready", or "failed".
struct JourneyPhoto: Codable, Equatable {
    let id: String
    let filename: String?
    let originalName: String?
    let mimetype: String?
    let size: Int?
    let uploadedAt: String?
    /// "photo" or "video". Missing from servers that predate videos.
    let kind: String?
    /// "processing", "ready" or "failed". Missing from servers that predate conversion.
    let status: String?
    /// Videos only: a JPEG frame from the converted video.
    let posterFilename: String?
    let durationMs: Int?
    let width: Int?
    let height: Int?

    var isVideo: Bool { kind == "video" }
    var isProcessing: Bool { status == "processing" }
    var isFailed: Bool { status == "failed" }

    /// Converted and ready to show. Items still converting, or that couldn't be, can't be opened.
    var isViewable: Bool {
        (status ?? "ready") == "ready" && !(filename ?? "").isEmpty
    }

    /// The image that represents this item in previews: the photo itself, or a converted
    /// video's poster.
    var previewFilename: String? {
        guard isViewable else { return nil }
        return isVideo ? posterFilename : filename
    }

    /// e.g. "0:42" or "1:02:05"
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

    /// "3 photos", "1 video", "3 photos and 1 video", as the web app describes media.
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
