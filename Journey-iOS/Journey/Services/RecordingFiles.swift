// Recording files in Documents: route_<ms>.csv while a trip records, route_<ms>.zip once it
// stops, until the upload succeeds.

import Foundation
import ZIPFoundation
import os.log

enum RecordingFiles {
    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Journey", category: "RecordingFiles")

    static func isRecording(_ url: URL) -> Bool {
        let name = url.lastPathComponent
        return name.hasPrefix("route_") && (name.hasSuffix(".csv") || name.hasSuffix(".zip"))
    }

    /// Writes `csv` into a zip at `zip`. Returns false, leaving `csv` alone, when it can't.
    static func zip(_ csv: URL, to zip: URL) -> Bool {
        let files = FileManager.default
        do {
            try? files.removeItem(at: zip)
            try files.zipItem(at: csv, to: zip)
            return true
        } catch {
            try? files.removeItem(at: zip)
            log.error("Couldn't zip \(csv.lastPathComponent): \(error.localizedDescription)")
            return false
        }
    }

    /// Recordings left in Documents that nothing is going to upload: a trip cut short by a
    /// crash, the system ending the app or a flat battery (its CSV), or one that stopped but
    /// never reached the queue (its zip). CSVs are zipped here. `active` is the CSV being
    /// written now, if any, and `known` the file names the upload queue already holds.
    static func leftovers(active: URL?, known: Set<String>) -> [URL] {
        let files = FileManager.default
        guard let entries = try? files.contentsOfDirectory(at: URL.documentsDirectory, includingPropertiesForKeys: nil) else {
            return []
        }
        var found: [URL] = []
        for url in entries where isRecording(url) && url.lastPathComponent != active?.lastPathComponent {
            if url.pathExtension == "zip" {
                if !known.contains(url.lastPathComponent) { found.append(url) }
                continue
            }
            let zipURL = url.deletingPathExtension().appendingPathExtension("zip")
            if known.contains(zipURL.lastPathComponent) || files.fileExists(atPath: zipURL.path) { continue }
            // A CSV that is only the header line holds no trip.
            let size = (try? files.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
            if size <= 64 {
                try? files.removeItem(at: url)
                continue
            }
            if zip(url, to: zipURL) {
                try? files.removeItem(at: url)
                found.append(zipURL)
            }
        }
        return found.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
