import ActivityKit
import Foundation

struct JourneyLiveActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var startedAt: Date
        var distanceMiles: Double
        var speedMph: Double
        var pointCount: Int
        var statusText: String
    }

    var journeyName: String
}
