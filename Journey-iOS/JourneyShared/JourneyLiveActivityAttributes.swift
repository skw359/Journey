import ActivityKit
import Foundation

nonisolated struct JourneyLiveActivityAttributes: ActivityAttributes {
    nonisolated struct ContentState: Codable, Hashable {
        var startedAt: Date
        var distanceMiles: Double
        var speedMph: Double
        var pointCount: Int
        var statusText: String
    }

    var journeyName: String
}
