// Writes the trip's route to a CSV and zips it for the phone.

import CoreLocation
import ZIPFoundation

final class RouteLog {
    /// Trips left on the watch at launch: an interrupted trip's CSV (zipped here) and zips
    /// whose transfer to the phone never finished. Only call before a trip starts.
    /// The CSV of the trip being recorded, so leftovers() never takes it.
    private(set) static var activeFile: URL?

    static func leftovers() -> [URL] {
        let files = FileManager.default
        guard let entries = try? files.contentsOfDirectory(at: URL.documentsDirectory, includingPropertiesForKeys: nil) else {
            return []
        }
        var found: [URL] = []
        for url in entries where url.lastPathComponent.hasPrefix("route_") && url.lastPathComponent != activeFile?.lastPathComponent {
            switch url.pathExtension {
            case "zip":
                found.append(url)
            case "csv":
                let zip = url.deletingPathExtension().appendingPathExtension("zip")
                if files.fileExists(atPath: zip.path) { continue }
                let size = (try? files.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
                if size <= header.utf8.count {
                    try? files.removeItem(at: url)
                } else if (try? files.zipItem(at: url, to: zip, compressionMethod: .deflate)) != nil {
                    try? files.removeItem(at: url)
                    found.append(zip)
                }
            default:
                break
            }
        }
        return found
    }

    private static let header = "ts_ms,lat,lon,ele_m,speed_ms,waypoint,note\n"

    private(set) var pointCount = 0
    private let csv: URL
    private let handle: FileHandle?

    init() {
        csv = URL.documentsDirectory.appending(path: "route_\(Int64(Date.now.timeIntervalSince1970 * 1000)).csv")
        FileManager.default.createFile(atPath: csv.path, contents: Data(Self.header.utf8))
        handle = try? FileHandle(forWritingTo: csv)
        _ = try? handle?.seekToEnd()
        Self.activeFile = csv
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
        if Self.activeFile == csv { Self.activeFile = nil }
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
                // The CSV stays, and the next launch tries again (see leftovers()).
                try? files.removeItem(at: zip)
                return nil
            }
        }.value
    }
}
