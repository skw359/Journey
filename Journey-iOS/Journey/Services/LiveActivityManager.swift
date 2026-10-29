import ActivityKit
import Foundation

@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private var currentActivity: Activity<JourneyLiveActivityAttributes>?
    private var lastSentState: JourneyLiveActivityAttributes.ContentState?
    private var lastUpdateAt = Date.distantPast

    private init() {
        currentActivity = Activity<JourneyLiveActivityAttributes>.activities.first
    }

    func start(startedAt: Date, gpsConnected: Bool) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let initialState = JourneyLiveActivityAttributes.ContentState(
            startedAt: startedAt,
            distanceMiles: 0,
            speedMph: 0,
            pointCount: 0,
            statusText: gpsConnected ? "Recording journey" : "Waiting for GPS"
        )

        syncCurrentActivityIfNeeded()
        lastSentState = initialState
        lastUpdateAt = Date()

        if let currentActivity {
            Task {
                await currentActivity.update(activityContent(for: initialState))
            }
            return
        }

        do {
            currentActivity = try Activity.request(
                attributes: JourneyLiveActivityAttributes(journeyName: "Journey"),
                content: activityContent(for: initialState),
                pushType: nil
            )
        } catch {
            print("Failed to start Live Activity: \(error)")
        }
    }

    func update(
        startedAt: Date,
        distanceMiles: Double,
        speedMph: Double,
        pointCount: Int,
        gpsConnected: Bool
    ) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        syncCurrentActivityIfNeeded()
        guard let currentActivity else { return }

        let nextState = JourneyLiveActivityAttributes.ContentState(
            startedAt: startedAt,
            distanceMiles: distanceMiles,
            speedMph: speedMph,
            pointCount: pointCount,
            statusText: gpsConnected ? "Recording journey" : "Waiting for GPS"
        )

        guard shouldSendUpdate(nextState) else { return }

        lastSentState = nextState
        lastUpdateAt = Date()

        Task {
            await currentActivity.update(activityContent(for: nextState))
        }
    }

    func end(
        startedAt: Date,
        distanceMiles: Double,
        speedMph: Double,
        pointCount: Int
    ) {
        syncCurrentActivityIfNeeded()
        guard let currentActivity else { return }

        let finalState = JourneyLiveActivityAttributes.ContentState(
            startedAt: startedAt,
            distanceMiles: distanceMiles,
            speedMph: speedMph,
            pointCount: pointCount,
            statusText: "Journey saved"
        )

        lastSentState = finalState

        Task {
            await currentActivity.end(
                activityContent(for: finalState),
                dismissalPolicy: .immediate
            )
        }

        self.currentActivity = nil
        lastSentState = nil
        lastUpdateAt = .distantPast
    }

    private func syncCurrentActivityIfNeeded() {
        if currentActivity == nil {
            currentActivity = Activity<JourneyLiveActivityAttributes>.activities.first
        }
    }

    private func activityContent(
        for state: JourneyLiveActivityAttributes.ContentState
    ) -> ActivityContent<JourneyLiveActivityAttributes.ContentState> {
        ActivityContent(
            state: state,
            staleDate: Date().addingTimeInterval(120)
        )
    }

    private func shouldSendUpdate(_ nextState: JourneyLiveActivityAttributes.ContentState) -> Bool {
        guard let lastSentState else { return true }

        let hasMeaningfulMetricChange =
            abs(nextState.distanceMiles - lastSentState.distanceMiles) >= 0.02 ||
            abs(nextState.speedMph - lastSentState.speedMph) >= 1.0 ||
            abs(nextState.pointCount - lastSentState.pointCount) >= 5

        let statusChanged = nextState.statusText != lastSentState.statusText
        let enoughTimePassed = Date().timeIntervalSince(lastUpdateAt) >= 5

        return hasMeaningfulMetricChange || statusChanged || enoughTimePassed
    }
}
