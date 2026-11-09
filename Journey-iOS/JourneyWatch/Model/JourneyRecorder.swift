// Owns the GPS, trip clock and everything measured during a trip.

import CoreLocation
import Observation
import UserNotifications
import WatchKit

@Observable
final class JourneyRecorder: NSObject {
    private static let minMovingSpeed: CLLocationSpeed = 0.4
    private static let staleAfter: TimeInterval = 10
    private static let moderateAltitude = 2438.0
    private static let highAltitude = 3657.0
    private static let waypointAccuracy: CLLocationAccuracy = 7
    private static let waypointFixCount = 3
    private static let placeRefreshDistance: CLLocationDistance = 1000
    private static let placeLookupInterval: TimeInterval = 60
    private static let usableFixAccuracy: CLLocationAccuracy = 500

    private(set) var isRecording = false
    private(set) var isPaused = false
    private(set) var isProcessing = false
    var finishedTrip: Trip?

    private(set) var hasFix = false
    private(set) var accuracy: CLLocationAccuracy?
    private(set) var location: CLLocation?
    private(set) var speed = 0.0
    private(set) var distance: CLLocationDistance = 0
    private(set) var elevation: CLLocationDistance?
    private(set) var heading: CLLocationDirection = 0
    private(set) var place = Place()
    private(set) var startDate = Date.now

    private(set) var waypoint: CLLocation?
    private(set) var speedgoal: Speedgoal?
    var isCreatingWaypoint = false
    var usesHeading = false { didSet { syncHeading() } }

    var hasUsableFix: Bool { accuracy.map { $0 <= Self.usableFixAccuracy } ?? false }

    private let manager = CLLocationManager()
    private let workout = WorkoutSession()
    private let geocoder = CLGeocoder()
    private var progress = TripProgress()
    private var routeLog: RouteLog?
    private var heartbeat: Task<Void, Never>?
    private var placeFix: CLLocation?
    private var nextPlaceLookup = Date.distantPast

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.activityType = .fitness
        manager.headingFilter = 1
        UNUserNotificationCenter.current().delegate = self
    }

    func prepare() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
        workout.requestAccess()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func start() {
        guard !isRecording else { return }
        progress = TripProgress()
        routeLog = RouteLog()
        startDate = .now
        isRecording = true
        isPaused = false
        speed = 0
        distance = 0
        elevation = nil
        waypoint = nil
        speedgoal = nil

        workout.start()
        manager.startUpdatingLocation()
        syncHeading()
        startHeartbeat()
        PhoneLink.shared.send(status: "recording_started")
        pushContext(state: "recording")
        WKInterfaceDevice.current().play(.start)
    }

    func end() {
        guard isRecording, !isProcessing else { return }
        isProcessing = true
        isCreatingWaypoint = false
        let trip = makeTrip()

        heartbeat?.cancel()
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
        workout.finish()
        pushContext(state: "idle")
        PhoneLink.shared.send(status: "recording_stopped")
        WKInterfaceDevice.current().play(.stop)

        Task {
            async let minimumDisplay: Void? = try? Task.sleep(for: .seconds(0.6))
            await pack()
            _ = await minimumDisplay

            isRecording = false
            isPaused = false
            isProcessing = false
            finishedTrip = trip
        }
    }

    func togglePause() {
        isPaused.toggle()
        if isPaused {
            progress.pauseBegan = .now
            manager.stopUpdatingLocation()
            workout.pause()
        } else {
            progress.pausedTime += progress.pauseBegan.map { Date.now.timeIntervalSince($0) } ?? 0
            progress.pauseBegan = nil
            progress.lastFix = nil
            progress.filter = SpikeFilter()
            progress.stillness = StillnessDetector()
            manager.startUpdatingLocation()
            workout.resume()
        }
        syncHeading()
    }

    func createWaypoint() {
        progress.waypointFixes = []
        isCreatingWaypoint = true
    }

    func setSpeedgoal(target: Int) {
        speedgoal = Speedgoal(target: target)
        updateSpeedgoal()
    }

    func restartHeading() {
        manager.stopUpdatingHeading()
        syncHeading()
    }

    func activeTime(at date: Date = .now) -> TimeInterval {
        max((progress.pauseBegan ?? date).timeIntervalSince(startDate) - progress.pausedTime, 0)
    }

    private func pack() async {
        guard let routeLog else { return }
        let hadPoints = routeLog.pointCount > 0
        if let zip = await routeLog.close() {
            PhoneLink.shared.transfer(zip)
        } else if hadPoints {
            WKInterfaceDevice.current().play(.failure)
        }
        self.routeLog = nil
    }

    private func makeTrip() -> Trip {
        let averageSpeed = progress.movingTime > 0 ? distance / progress.movingTime : 0
        return Trip(miles: distance / Units.metersPerMile,
                    topSpeed: progress.topSpeed,
                    averageSpeed: averageSpeed * Units.mphPerMetersPerSecond,
                    duration: activeTime(),
                    highElevation: progress.elevationHistory.high,
                    lowElevation: progress.elevationHistory.low,
                    speedSamples: progress.speedHistory.samples(),
                    elevationSamples: progress.elevationHistory.samples())
    }

    private func record(_ fix: CLLocation) {
        let previous = progress.lastFix
        progress.lastFix = fix

        let step = previous.map { fix.distance(from: $0) } ?? 0
        let elapsed = previous.map { fix.timestamp.timeIntervalSince($0.timestamp) } ?? 0
        let metersPerSecond = fix.speed >= 0 ? fix.speed : (elapsed > 0 ? step / elapsed : 0)
        speed = metersPerSecond * Units.mphPerMetersPerSecond

        if metersPerSecond > Self.minMovingSpeed, elapsed > 0, step / elapsed <= SpikeFilter.maxSpeed {
            distance += step
            progress.movingTime += elapsed
            progress.topSpeed = max(progress.topSpeed, speed)
        }

        progress.speedHistory.record(speed, at: fix.timestamp)
        if fix.verticalAccuracy >= 0 {
            elevation = fix.altitude
            progress.elevationHistory.record(fix.altitude, at: fix.timestamp)
            sendAltitudeAlert(for: fix.altitude)
        }
        routeLog?.append(fix)
        updateSpeedgoal()

        if progress.stillness.isStill(after: fix) { end() }
    }

    private func updateSpeedgoal() {
        if speedgoal?.update(mph: speed, at: activeTime()) == true {
            WKInterfaceDevice.current().play(.success)
        }
    }

    private func addWaypointFix(_ fix: CLLocation) {
        guard fix.horizontalAccuracy <= Self.waypointAccuracy else { return }
        progress.waypointFixes.append(fix)
        guard progress.waypointFixes.count == Self.waypointFixCount else { return }
        waypoint = .weightedAverage(of: progress.waypointFixes)
        isCreatingWaypoint = false
        WKInterfaceDevice.current().play(.success)
    }

    private func sendAltitudeAlert(for meters: CLLocationDistance) {
        if meters > Self.highAltitude, !progress.sentHighAlert {
            progress.sentHighAlert = true
            notify("You're at a very high altitude. Please be cautious of lower oxygen levels and potential altitude sickness.")
        } else if meters > Self.moderateAltitude, meters <= Self.highAltitude, !progress.sentModerateAlert {
            progress.sentModerateAlert = true
            notify("You're at a high altitude. Oxygen levels may be lower than usual.")
        }
    }

    private func notify(_ message: String) {
        let content = UNMutableNotificationContent()
        content.title = "Altitude Alert"
        content.body = message
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    private func startHeartbeat() {
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                self.expireStaleReadings()
                self.pushContext(state: "recording")
            }
        }
    }

    private func expireStaleReadings() {
        guard !isPaused else { return }
        if Date.now.timeIntervalSince(progress.lastSignal) > Self.staleAfter { accuracy = nil }
        if Date.now.timeIntervalSince(progress.lastFix?.timestamp ?? startDate) > Self.staleAfter { speed = 0 }
    }

    private func pushContext(state: String) {
        PhoneLink.shared.updateContext(state: state,
                                       points: routeLog?.pointCount ?? 0,
                                       waypoints: waypoint == nil ? 0 : 1,
                                       duration: activeTime())
    }

    private func syncHeading() {
        guard CLLocationManager.headingAvailable() else { return }
        if isRecording, !isPaused, !isProcessing, usesHeading {
            manager.startUpdatingHeading()
        } else {
            manager.stopUpdatingHeading()
        }
    }

    private func handle(_ fix: CLLocation) {
        guard !isPaused, !isProcessing else { return }
        accuracy = fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : nil
        progress.lastSignal = .now
        guard progress.filter.accepts(fix) else { return }

        hasFix = true
        guard isRecording else {
            manager.stopUpdatingLocation()
            return
        }
        location = fix
        refreshPlace(for: fix)
        if isCreatingWaypoint { addWaypointFix(fix) }
        record(fix)
    }

    private func refreshPlace(for fix: CLLocation) {
        guard !geocoder.isGeocoding, Date.now >= nextPlaceLookup,
              placeFix.map({ fix.distance(from: $0) >= Self.placeRefreshDistance }) ?? true else { return }
        nextPlaceLookup = .now + Self.placeLookupInterval
        Task {
            guard let placemark = try? await geocoder.reverseGeocodeLocation(fix).first else { return }
            placeFix = fix
            let isUS = placemark.isoCountryCode == "US"
            let region = isUS ? placemark.administrativeArea : placemark.country
            place = Place(name: [placemark.locality, region].compactMap { $0 }.joined(separator: ", "),
                          county: isUS ? placemark.subAdministrativeArea ?? "" : "")
        }
    }
}

extension JourneyRecorder: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        locations.forEach(handle)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard !isPaused else { return }
        heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        accuracy = nil
    }
}

extension JourneyRecorder: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
