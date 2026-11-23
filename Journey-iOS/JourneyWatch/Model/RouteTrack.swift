// Keeps a small, bounded copy of the trip's route for the live map.

import CoreLocation

struct RouteTrack {
    private static let minStep: CLLocationDistance = 3
    private static let recentCapacity = 128
    private static let olderCapacity = 256

    /// Goes up once per added point, so views can tell cheaply whether the route changed.
    private(set) var revision = 0
    private var recent: [CLLocationCoordinate2D] = []
    private var older: [CLLocationCoordinate2D] = []
    private var olderStep: CLLocationDistance = 12

    var last: CLLocationCoordinate2D? { recent.last }
    var coordinates: [CLLocationCoordinate2D] { older + recent }

    func shouldAdd(_ coordinate: CLLocationCoordinate2D) -> Bool {
        last.map { $0.distance(to: coordinate) >= Self.minStep } ?? true
    }

    /// The newest stretch stays at full detail, because that is what the map is zoomed in on.
    /// Everything before it is thinned further each time it fills up, so memory stays flat
    /// however long the trip runs.
    mutating func add(_ coordinate: CLLocationCoordinate2D) {
        revision += 1
        recent.append(coordinate)
        guard recent.count > Self.recentCapacity else { return }

        let aged = recent.prefix(Self.recentCapacity / 2)
        recent.removeFirst(aged.count)
        for point in aged where older.last.map({ $0.distance(to: point) >= olderStep }) ?? true {
            older.append(point)
        }

        guard older.count >= Self.olderCapacity else { return }
        older = stride(from: 0, to: older.count, by: 2).map { older[$0] }
        olderStep *= 2
    }
}

extension CLLocationCoordinate2D {
    /// Flat-earth distance in meters, accurate enough for the short steps compared here.
    func distance(to other: CLLocationCoordinate2D) -> CLLocationDistance {
        let metersPerDegree = 111_320.0
        let north = (other.latitude - latitude) * metersPerDegree
        let east = (other.longitude - longitude) * metersPerDegree * cos(latitude * .pi / 180)
        return (north * north + east * east).squareRoot()
    }
}
