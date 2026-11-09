// Writes the trip's route to a CSV and zips it for the phone.

import CoreLocation
import ZIPFoundation

final class RouteLog {
    private static let header = "ts_ms,lat,lon,ele_m,speed_ms,waypoint,note\n"

    private(set) var pointCount = 0
    private let csv: URL
    private let handle: FileHandle?

    init() {
        csv = URL.documentsDirectory.appending(path: "route_\(Int64(Date.now.timeIntervalSince1970 * 1000)).csv")
        FileManager.default.createFile(atPath: csv.path, contents: Data(Self.header.utf8))
        handle = try? FileHandle(forWritingTo: csv)
        _ = try? handle?.seekToEnd()
    }

    func append(_ fix: CLLocation) {
        let timestamp = Int64(fix.timestamp.timeIntervalSince1970 * 1000)
        let elevation = fix.verticalAccuracy >= 0 ? "\(fix.altitude)" : ""
        let row = "\(timestamp),\(fix.coordinate.latitude),\(fix.coordinate.longitude),\(elevation),\(max(fix.speed, 0)),,\n"
        guard (try? handle?.write(contentsOf: Data(row.utf8))) != nil else { return }
        pointCount += 1
    }

    func close() async -> URL? {
        try? handle?.close()
        let csv = csv
        let hasPoints = pointCount > 0
        return await Task.detached(priority: .userInitiated) { () -> URL? in
            let files = FileManager.default
            guard hasPoints else {
                try? files.removeItem(at: csv)
                return nil
            }
            let zip = csv.deletingPathExtension().appendingPathExtension("zip")
            do {
                try files.zipItem(at: csv, to: zip, compressionMethod: .deflate)
                try? files.removeItem(at: csv)
                return zip
            } catch {
                return nil
            }
        }.value
    }
}
