// Workout session that keeps the app running with the wrist down.

import HealthKit

final class WorkoutSession {
    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    func requestAccess() {
        store.requestAuthorization(toShare: [.workoutType()], read: []) { _, _ in }
    }

    func start() {
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .walking
        configuration.locationType = .outdoor
        guard let session = try? HKWorkoutSession(healthStore: store, configuration: configuration) else { return }

        let builder = session.associatedWorkoutBuilder()
        builder.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: configuration)
        session.startActivity(with: .now)
        builder.beginCollection(withStart: .now) { _, _ in }
        self.session = session
        self.builder = builder
    }

    func pause() {
        session?.pause()
    }

    func resume() {
        session?.resume()
    }

    func finish() {
        guard let session, let builder else { return }
        self.session = nil
        self.builder = nil
        session.end()
        Task {
            try? await builder.endCollection(at: .now)
            _ = try? await builder.finishWorkout()
        }
    }
}
