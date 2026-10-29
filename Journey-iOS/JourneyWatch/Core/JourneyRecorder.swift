import Foundation
import CoreLocation
import HealthKit
import WatchConnectivity
import ZIPFoundation
import WatchKit
import Combine
import UserNotifications

// MARK: - Data Types

struct ElevationReading: Equatable {
    var time: Date
    var elevation: Double

    static func == (lhs: ElevationReading, rhs: ElevationReading) -> Bool {
        return lhs.time == rhs.time && lhs.elevation == rhs.elevation
    }
}

struct SpeedReading: Equatable {
    var time: Date
    var speed: Double

    static func == (lhs: SpeedReading, rhs: SpeedReading) -> Bool {
        return lhs.time == rhs.time && lhs.speed == rhs.speed
    }
}

// MARK: - CLLocation Extensions

extension CLLocation {
    func fetchCityAndState(completion: @escaping (String?, String?) -> Void) {
        CLGeocoder().reverseGeocodeLocation(self) { placemarks, error in
            if let error = error {
                print("Geocoding failed with error: \(error.localizedDescription)")
                completion(nil, nil)
            } else if let placemark = placemarks?.first {
                let cityName = placemark.locality ?? ""
                let stateName = placemark.administrativeArea ?? ""
                let countyName = placemark.subAdministrativeArea ?? ""
                let fullLocation = "\(cityName), \(stateName)"
                completion(fullLocation, countyName)
            } else {
                completion(nil, nil)
            }
        }
    }

    func bearing(to destination: CLLocation) -> Double {
        let lat1 = self.coordinate.latitude.toRadians()
        let lon1 = self.coordinate.longitude.toRadians()
        let lat2 = destination.coordinate.latitude.toRadians()
        let lon2 = destination.coordinate.longitude.toRadians()

        let dLon = lon2 - lon1
        let y = sin(dLon) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        let bearing = atan2(y, x).toDegrees()

        return (bearing >= 0) ? bearing : (360 + bearing)
    }
}

extension Double {
    func toRadians() -> Double { self * .pi / 180 }
    func toDegrees() -> Double { self * 180 / .pi }
}

// MARK: - JourneyRecorder

final class JourneyRecorder: NSObject, ObservableObject {
    // MARK: Recording State
    @Published var isRecording = false
    @Published var pointCount = 0
    @Published var recordingDuration: TimeInterval?
    @Published var waypointCount = 0
    @Published var paused: Bool = false

    // MARK: Distance (meters internally, miles for UI)
    @Published var distanceTraveled: CLLocationDistance = 0
    private var lastDistanceLocation: CLLocation?

    // MARK: GPS State
    @Published var gpsConnected = false
    @Published var gpsAccuracy: CLLocationAccuracy?
    @Published var obtainedGPS = false
    @Published var latestLocation: CLLocation?

    // MARK: Speed (mph for UI)
    @Published var speed: Double = 0.0
    @Published var topSpeed: Double = 0.0
    @Published var averageSpeed: Double = 0.0
    @Published var currentSpeedMps: CLLocationSpeed = 0
    @Published var speedReadings: [SpeedReading] = []

    // MARK: Elevation
    @Published var currentElevation: Double = 0.0
    @Published var elevationReadings: [ElevationReading] = []
    @Published var moderateAltitudeNotificationSent = false
    @Published var highAltitudeNotificationSent = false

    // MARK: Time
    @Published var totalTimeTimer: Int = 0
    private var pauseStartTime: Date?
    private var totalPausedTime: TimeInterval = 0

    // MARK: Heading / Compass
    @Published var userHeading: Double = 0.0
    @Published var heading: Double = 0.0
    @Published var recalibratingCompass = false
    private var calibrationReadings: [Double] = []
    private let calibrationDuration: TimeInterval = 20

    // MARK: Waypoint Navigation
    @Published var averagedWaypointLocation: CLLocation?
    @Published var bearingToWaypoint: Double = 0
    @Published var calculatingWaypoint = false
    private var waypointLocations: [CLLocation] = []
    private var waypointCompletion: ((CLLocation?) -> Void)?

    // MARK: Geocoding
    @Published var currentLocationName: String = ""
    @Published var currentCountyName: String = ""
    private var lastGeocodedLocation: CLLocation?
    private let minimumDistanceForGeocoding: CLLocationDistance = 1000
    private var lastLocationNameUpdateTime: Date?

    // MARK: Distance (miles for UI)
    var distance: Double {
        distanceTraveled / 1609.344
    }

    var totalTimeTextTimer: String {
        let hours = totalTimeTimer / 3600
        let minutes = (totalTimeTimer % 3600) / 60
        let seconds = totalTimeTimer % 60
        if hours > 0 {
            return String(format: "%01d:%02d:%02d", hours, minutes, seconds)
        } else {
            return String(format: "%02d:%02d", minutes, seconds)
        }
    }

    var totalTime: Double {
        Double(totalTimeTimer)
    }

    // MARK: - Location + Motion Window (from original JourneyRecorder)
    private let locationManager = CLLocationManager()
    private var recent: [CLLocation] = []
    private let windowSeconds: TimeInterval = 10
    private let maxRecentLocations = 100
    private let startSpeed: CLLocationSpeed = 0.5
    private let stopSpeed:  CLLocationSpeed = 0.3
    private let startDisplacement: CLLocationDistance = 10
    private let stopDisplacement:  CLLocationDistance = 5
    private var stopCandidateBegan: Date?

    // MARK: - GPS Spike Filtering (7-layer)
    private var lastValidLocation: CLLocation?
    private var suspiciousLocations: [(location: CLLocation, timestamp: Date)] = []
    private let maxSuspiciousLocations = 20
    private let maxReasonableSpeed: CLLocationSpeed = 40.0
    private let maxAcceleration: Double = 5.0
    private let minAccuracy: CLLocationAccuracy = 50.0
    private let suspiciousWindowSeconds: TimeInterval = 5.0
    private var recentValidSpeeds: [CLLocationSpeed] = []
    private let speedHistoryCount = 10
    private var validLocationCount = 0
    private let warmupLocationCount = 5
    private var consecutiveSuspiciousCount = 0

    // MARK: - HealthKit
    private let healthStore = HKHealthStore()
    private var workoutSession: HKWorkoutSession?
    private var workoutBuilder: HKLiveWorkoutBuilder?

    // MARK: - Recording Artifacts
    private var csvURL: URL?
    private var zipURL: URL?
    private var fileHandle: FileHandle?
    private var recordingStartTime: Date?
    private var updateTimer: Timer?
    private var writeCounter = 0

    private var lastContextPush = Date.distantPast
    private let contextPushInterval: TimeInterval = 5

    // MARK: - Elevation/Speed significant change tracking
    private let significantElevationChange: Double = 5.0
    private let significantSpeedChange: Double = 2.23694
    private let minTimeBetweenReadings: TimeInterval = 10
    private var lastSignificantElevationReading: ElevationReading?
    private var lastSignificantSpeedReading: SpeedReading?

    // MARK: - Init
    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.distanceFilter = 5
        locationManager.activityType = .fitness

        // Start location + heading immediately for pre-recording screens
        locationManager.requestWhenInUseAuthorization()
        locationManager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            locationManager.startUpdatingHeading()
        }
    }

    // MARK: - Permissions
    func requestPermissions() {
        locationManager.requestWhenInUseAuthorization()
        let workoutType = HKWorkoutType.workoutType()
        let toShare: Set<HKSampleType> = [workoutType]
        let toRead:  Set<HKObjectType> = [workoutType]
        healthStore.requestAuthorization(toShare: toShare, read: toRead) { _, _ in }
    }

    // MARK: - Waypoint Marking (CSV)
    func markWaypoint() -> Bool {
        guard isRecording, let location = lastValidLocation else { return false }
        writeWaypoint(location)
        DispatchQueue.main.async {
            self.waypointCount += 1
        }
        WKInterfaceDevice.current().play(.click)
        pushContext(state: "recording")
        return true
    }

    private func writeWaypoint(_ loc: CLLocation) {
        guard let h = fileHandle else { return }
        let ts = Int64(loc.timestamp.timeIntervalSince1970 * 1000)
        let lat = loc.coordinate.latitude
        let lon = loc.coordinate.longitude
        let ele = loc.altitude
        let speed = max(loc.speed, 0)
        if let data = "\(ts),\(lat),\(lon),\(ele),\(speed),1,\n".data(using: .utf8) {
            try? h.write(contentsOf: data)
        }
        try? h.synchronize()
    }

    // MARK: - Public Controls
    func startRecording() {
        guard !isRecording else { return }
        startWorkoutSession()
        pushContext(state: "recording")

        // Prepare CSV
        let fileName = "route_\(Int64(Date().timeIntervalSince1970 * 1000)).csv"
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        csvURL = docs.appendingPathComponent(fileName)
        zipURL = csvURL!.deletingPathExtension().appendingPathExtension("zip")
        let header = "ts_ms,lat,lon,ele_m,speed_ms,waypoint,note\n"
        FileManager.default.createFile(atPath: csvURL!.path, contents: Data(header.utf8))
        fileHandle = try? FileHandle(forWritingTo: csvURL!)
        _ = try? fileHandle?.seekToEnd()

        // Reset UI state
        isRecording = true
        pointCount = 0
        waypointCount = 0
        writeCounter = 0
        recordingStartTime = Date()
        paused = false
        pauseStartTime = nil
        totalPausedTime = 0
        totalTimeTimer = 0
        distanceTraveled = 0
        lastDistanceLocation = nil
        speed = 0.0
        topSpeed = 0.0
        averageSpeed = 0.0
        currentSpeedMps = 0

        // Clear readings for new recording
        elevationReadings.removeAll()
        speedReadings.removeAll()
        lastSignificantElevationReading = nil
        lastSignificantSpeedReading = nil
        moderateAltitudeNotificationSent = false
        highAltitudeNotificationSent = false

        // Record initial elevation
        if let loc = locationManager.location {
            recordElevationReading(elevation: loc.altitude)
        }

        // Ensure location + heading updates are running
        locationManager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            locationManager.startUpdatingHeading()
        }

        // Timer for elapsed time
        updateTimer?.invalidate()
        updateTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, !self.paused, let start = self.recordingStartTime else { return }
            let elapsed = Date().timeIntervalSince(start) - self.totalPausedTime
            self.recordingDuration = elapsed
            self.totalTimeTimer = Int(elapsed)
        }

        WatchConnectivityManager.shared.sendMessage(["status": "recording_started"])
        WKInterfaceDevice.current().play(.start)
    }

    func stopRecording() {
        guard isRecording else { return }
        pushContext(state: "idle")

        // Stop timers (but keep location/heading running for post-trip & pre-recording screens)
        updateTimer?.invalidate()
        updateTimer = nil

        // Flush and close CSV
        try? fileHandle?.synchronize()
        try? fileHandle?.close()
        fileHandle = nil

        // Zip + transfer
        if let csvURL, let zipURL {
            createZip(from: csvURL, to: zipURL)
            WatchConnectivityManager.shared.transferFile(zipURL)
            try? FileManager.default.removeItem(at: csvURL)
        }

        // Tear down workout
        stopWorkoutSession()

        // Reset recording state but keep readings alive for TravelRecordedView
        isRecording = false
        paused = false
        pointCount = 0
        waypointCount = 0
        writeCounter = 0
        recordingDuration = nil
        recordingStartTime = nil
        csvURL = nil
        zipURL = nil
        recent.removeAll(keepingCapacity: false)
        stopCandidateBegan = nil
        currentSpeedMps = 0

        lastDistanceLocation = nil

        // Reset GPS filtering state
        lastValidLocation = nil
        suspiciousLocations.removeAll(keepingCapacity: false)
        recentValidSpeeds.removeAll(keepingCapacity: false)
        validLocationCount = 0
        consecutiveSuspiciousCount = 0

        WatchConnectivityManager.shared.sendMessage(["status": "recording_stopped"])
        WKInterfaceDevice.current().play(.stop)
    }

    // MARK: - Pause / Resume
    func togglePause() {
        paused.toggle()
        if paused {
            pauseStartTime = Date()
            locationManager.stopUpdatingLocation()
            locationManager.stopUpdatingHeading()
            // Pause workout session
            workoutSession?.pause()
        } else {
            if let pauseStart = pauseStartTime {
                totalPausedTime += Date().timeIntervalSince(pauseStart)
            }
            pauseStartTime = nil
            locationManager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() {
                locationManager.startUpdatingHeading()
            }
            // Resume workout session
            workoutSession?.resume()
        }
    }

    // MARK: - Waypoint Calculation (for navigation)
    func startWaypointCalculation() {
        calculatingWaypoint = true
        waypointLocations.removeAll()
        locationManager.requestLocation()
    }

    func averageWaypointLocation(completion: @escaping (CLLocation?) -> Void) {
        guard waypointLocations.isEmpty else { return }
        waypointLocations.removeAll()
        waypointCompletion = completion
        locationManager.requestLocation()
    }

    private func handleWaypointCalculation(location: CLLocation) {
        if waypointLocations.count < 3 {
            if location.horizontalAccuracy <= 7.0 {
                waypointLocations.append(location)
            }
        } else {
            var totalWeight: Double = 0
            var weightedSumLat: Double = 0
            var weightedSumLon: Double = 0

            for waypoint in waypointLocations {
                let weight = 1.0 / max(waypoint.horizontalAccuracy, 1.0)
                totalWeight += weight
                weightedSumLat += waypoint.coordinate.latitude * weight
                weightedSumLon += waypoint.coordinate.longitude * weight
            }

            let averageLat = weightedSumLat / totalWeight
            let averageLon = weightedSumLon / totalWeight

            averagedWaypointLocation = CLLocation(latitude: averageLat, longitude: averageLon)
            waypointCompletion?(averagedWaypointLocation)
            waypointLocations.removeAll()
            calculatingWaypoint = false
            updateBearingForWaypoint()
        }
    }

    // MARK: - Compass Calibration
    func recalibrateCompass() {
        guard CLLocationManager.headingAvailable() else { return }
        recalibratingCompass = true
        calibrationReadings.removeAll()
        locationManager.stopUpdatingHeading()
        locationManager.startUpdatingHeading()
        NotificationCenter.default.post(name: Notification.Name("ShowCalibrationInstructions"), object: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + calibrationDuration) { [weak self] in
            self?.finalizeCalibration()
        }
    }

    private func finalizeCalibration() {
        guard !calibrationReadings.isEmpty else {
            recalibratingCompass = false
            return
        }
        let averageHeading = calibrationReadings.reduce(0, +) / Double(calibrationReadings.count)
        heading = averageHeading
        userHeading = averageHeading
        recalibratingCompass = false
        NotificationCenter.default.post(name: Notification.Name("CalibrationComplete"), object: nil)
    }

    func alignedWithCardinalDirection() -> Bool {
        let northRange: ClosedRange<Double> = 350.0...360.0
        let northLowerBound: ClosedRange<Double> = 0.0...10.0
        let otherCardinalDirections: [Double] = [90, 180, 270]

        if northRange.contains(self.heading) || northLowerBound.contains(self.heading) {
            return true
        }
        return otherCardinalDirections.contains { abs(self.heading - $0) <= 10.0 }
    }

    // MARK: - Bearing to Waypoint
    private func updateBearingForWaypoint() {
        guard let currentLocation = latestLocation,
              let waypointLocation = averagedWaypointLocation else {
            bearingToWaypoint = 0
            return
        }
        let bearingFromNorth = currentLocation.bearing(to: waypointLocation)
        let relativeBearing = bearingFromNorth - userHeading
        bearingToWaypoint = relativeBearing >= 0 ? relativeBearing : 360 + relativeBearing
    }

    // MARK: - Geocoding
    private func updateLocationName(for location: CLLocation) {
        let currentTime = Date()
        if let lastUpdateTime = lastLocationNameUpdateTime,
           currentTime.timeIntervalSince(lastUpdateTime) < 60 {
            return
        }
        if let lastLocation = lastGeocodedLocation,
           location.distance(from: lastLocation) < minimumDistanceForGeocoding {
            return
        }
        location.fetchCityAndState { [weak self] locationName, countyName in
            DispatchQueue.main.async {
                self?.currentLocationName = locationName ?? ""
                self?.currentCountyName = countyName ?? ""
                self?.lastGeocodedLocation = location
                self?.lastLocationNameUpdateTime = currentTime
            }
        }
    }

    // MARK: - Elevation Safety Notifications
    private func elevationSafetyNotification(elevation: Double) {
        let moderateAltitude = 2438.0
        let highAltitude = 3657.0

        if elevation > moderateAltitude && elevation <= highAltitude && !moderateAltitudeNotificationSent {
            moderateAltitudeNotificationSent = true
            sendNotification(title: "Altitude Alert", message: "You're at a high altitude. Oxygen levels may be lower than usual.")
        } else if elevation > highAltitude && !highAltitudeNotificationSent {
            highAltitudeNotificationSent = true
            sendNotification(title: "Altitude Alert", message: "You're at a very high altitude. Please be cautious of lower oxygen levels and potential altitude sickness.")
        }
    }

    private func sendNotification(title: String, message: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    private func recordElevationReading(elevation: Double) {
        let newReading = ElevationReading(time: Date(), elevation: elevation)
        elevationReadings.append(newReading)
        lastSignificantElevationReading = newReading
    }

    // MARK: - Context Push
    private func pushContext(state: String) {
        let payload: [String: Any] = [
            "watch_state": state,
            "point_count": pointCount,
            "waypoint_count": waypointCount,
            "duration_sec": Int(recordingDuration ?? 0),
            "ts": Date().timeIntervalSince1970
        ]
        WatchConnectivityManager.shared.updateContext(payload)
    }

    // MARK: - HK Workout (background)
    private func startWorkoutSession() {
        let cfg = HKWorkoutConfiguration()
        cfg.activityType = .walking
        cfg.locationType = .outdoor
        do {
            workoutSession = try HKWorkoutSession(healthStore: healthStore, configuration: cfg)
            workoutBuilder = workoutSession?.associatedWorkoutBuilder()
            workoutSession?.delegate = self
            workoutBuilder?.delegate = self
            workoutBuilder?.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: cfg)
            workoutSession?.startActivity(with: Date())
            workoutBuilder?.beginCollection(withStart: Date()) { _, _ in }
        } catch {
            // Workout session failed to start
        }
    }

    private func stopWorkoutSession() {
        workoutSession?.end()
        workoutBuilder?.endCollection(withEnd: Date()) { [weak self] _, _ in
            self?.workoutBuilder?.finishWorkout { _, _ in }
        }
        workoutSession = nil
        workoutBuilder = nil
    }

    // MARK: - GPS Spike Filtering (7-layer)

    private func isValidLocation(_ location: CLLocation) -> Bool {
        guard location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= minAccuracy else {
            return false
        }
        guard abs(location.coordinate.latitude) <= 90,
              abs(location.coordinate.longitude) <= 180 else {
            return false
        }
        if location.verticalAccuracy >= 0 && location.verticalAccuracy > 100 {
            return false
        }
        guard let lastValid = lastValidLocation else {
            return true
        }
        let distance = location.distance(from: lastValid)
        let timeInterval = location.timestamp.timeIntervalSince(lastValid.timestamp)
        guard timeInterval > 0.1 else {
            return false
        }
        guard timeInterval < 30.0 else {
            validLocationCount = 0
            recentValidSpeeds.removeAll()
            return true
        }
        let impliedSpeed = distance / timeInterval
        if validLocationCount < warmupLocationCount {
            if impliedSpeed > maxReasonableSpeed {
                return false
            }
            return true
        }
        if impliedSpeed > maxReasonableSpeed {
            addSuspiciousLocation(location)
            consecutiveSuspiciousCount += 1
            return false
        }
        if location.speed >= 0 {
            let reportedSpeed = location.speed
            if reportedSpeed < 5.0 && impliedSpeed > 15.0 {
                addSuspiciousLocation(location)
                consecutiveSuspiciousCount += 1
                return false
            }
            let speedDiff = abs(reportedSpeed - impliedSpeed)
            if speedDiff > max(20.0, max(reportedSpeed, impliedSpeed) * 0.7) {
                addSuspiciousLocation(location)
                consecutiveSuspiciousCount += 1
                return false
            }
        }
        if !recentValidSpeeds.isEmpty {
            let avgRecentSpeed = recentValidSpeeds.reduce(0, +) / Double(recentValidSpeeds.count)
            let maxRecentSpeed = recentValidSpeeds.max() ?? 0
            let acceleration = (impliedSpeed - avgRecentSpeed) / timeInterval
            if abs(acceleration) > maxAcceleration {
                if !isConsistentAcceleration(impliedSpeed: impliedSpeed, timeInterval: timeInterval) {
                    addSuspiciousLocation(location)
                    consecutiveSuspiciousCount += 1
                    return false
                }
            }
            if impliedSpeed > maxRecentSpeed * 2.5 && impliedSpeed > 10.0 {
                addSuspiciousLocation(location)
                consecutiveSuspiciousCount += 1
                return false
            }
            let recentSuspicious = suspiciousLocations.filter {
                Date().timeIntervalSince($0.timestamp) < suspiciousWindowSeconds
            }
            if !recentSuspicious.isEmpty || consecutiveSuspiciousCount > 0 {
                let conservativeMax = min(maxReasonableSpeed * 0.5, avgRecentSpeed * 2.0)
                if impliedSpeed > conservativeMax {
                    addSuspiciousLocation(location)
                    consecutiveSuspiciousCount += 1
                    return false
                }
            }
        }
        if location.horizontalAccuracy > lastValid.horizontalAccuracy * 3.0 {
            if impliedSpeed > 10.0 {
                addSuspiciousLocation(location)
                consecutiveSuspiciousCount += 1
                return false
            }
        }
        consecutiveSuspiciousCount = 0
        return true
    }

    private func isConsistentAcceleration(impliedSpeed: CLLocationSpeed, timeInterval: TimeInterval) -> Bool {
        guard recentValidSpeeds.count >= 4 else { return false }
        var increases = 0
        for i in 0..<(recentValidSpeeds.count - 1) {
            if recentValidSpeeds[i+1] > recentValidSpeeds[i] {
                increases += 1
            }
        }
        let increasingRatio = Double(increases) / Double(recentValidSpeeds.count - 1)
        if increasingRatio >= 0.75 {
            return true
        }
        let allHighSpeed = recentValidSpeeds.allSatisfy { $0 > 15.0 }
        return allHighSpeed
    }

    private func addSuspiciousLocation(_ location: CLLocation) {
        if suspiciousLocations.count >= maxSuspiciousLocations {
            suspiciousLocations.removeFirst(suspiciousLocations.count - maxSuspiciousLocations + 1)
        }
        suspiciousLocations.append((location: location, timestamp: Date()))
    }

    private func updateSpeedHistory(with speed: CLLocationSpeed) {
        recentValidSpeeds.append(speed)
        if recentValidSpeeds.count > speedHistoryCount {
            recentValidSpeeds.removeFirst()
        }
    }

    // MARK: - CSV Write
    private func write(_ loc: CLLocation) {
        guard let h = fileHandle else { return }
        let ts = Int64(loc.timestamp.timeIntervalSince1970 * 1000)
        let lat = loc.coordinate.latitude
        let lon = loc.coordinate.longitude
        let ele = loc.altitude
        let speed = max(loc.speed, 0)
        if let data = "\(ts),\(lat),\(lon),\(ele),\(speed),,\n".data(using: .utf8) {
            try? h.write(contentsOf: data)
            DispatchQueue.main.async { self.pointCount += 1 }
            writeCounter += 1
            if writeCounter % 50 == 0 {
                try? h.synchronize()
            }
        }
    }

    private func createZip(from source: URL, to destination: URL) {
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.zipItem(at: source, to: destination)
        } catch {
            // ZIP creation failed
        }
    }

    // MARK: - Update Metrics (speed, elevation, distance from validated locations)
    private func updateMetrics(with location: CLLocation) {
        guard !paused, isRecording else { return }

        let currentTime = location.timestamp
        let locElevation = location.altitude
        let currentSpeed = max(location.speed, 0)

        // Update speed in mph
        DispatchQueue.main.async {
            self.speed = max(currentSpeed * 2.23694, 0)
            self.currentElevation = locElevation
        }

        if let lastLoc = lastDistanceLocation {
            let timeInterval = currentTime.timeIntervalSince(lastLoc.timestamp)

            if currentSpeed > 0.4 {
                let newDistance = location.distance(from: lastLoc)
                if newDistance.isFinite && newDistance >= 0 && newDistance < 1000 {
                    DispatchQueue.main.async {
                        self.distanceTraveled += newDistance
                        self.topSpeed = max(self.topSpeed, currentSpeed * 2.23694)
                        if self.totalTimeTimer > 0 {
                            let hours = Double(self.totalTimeTimer) / 3600.0
                            if hours > 0 {
                                self.averageSpeed = self.distance / hours
                            }
                        }
                    }
                }
            }

            // Elevation readings (significant change or time based)
            if let lastReading = lastSignificantElevationReading {
                let elevationChange = abs(locElevation - lastReading.elevation)
                let timeChange = currentTime.timeIntervalSince(lastReading.time)
                if elevationChange >= significantElevationChange || timeChange >= minTimeBetweenReadings {
                    let newReading = ElevationReading(time: currentTime, elevation: locElevation)
                    DispatchQueue.main.async {
                        self.elevationReadings.append(newReading)
                    }
                    lastSignificantElevationReading = newReading
                }
            } else {
                let newReading = ElevationReading(time: currentTime, elevation: locElevation)
                DispatchQueue.main.async {
                    self.elevationReadings.append(newReading)
                }
                lastSignificantElevationReading = newReading
            }

            // Speed readings (significant change or time based)
            let speedMph = max(currentSpeed * 2.23694, 0)
            if let lastReading = lastSignificantSpeedReading {
                let speedChange = abs(currentSpeed - lastReading.speed / 2.23694)
                let timeChange = currentTime.timeIntervalSince(lastReading.time)
                if speedChange >= significantSpeedChange || timeChange >= minTimeBetweenReadings {
                    let newReading = SpeedReading(time: currentTime, speed: speedMph)
                    DispatchQueue.main.async {
                        self.speedReadings.append(newReading)
                    }
                    lastSignificantSpeedReading = newReading
                }
            } else {
                let newReading = SpeedReading(time: currentTime, speed: speedMph)
                DispatchQueue.main.async {
                    self.speedReadings.append(newReading)
                }
                lastSignificantSpeedReading = newReading
            }
        } else {
            // First reading
            let initElev = ElevationReading(time: currentTime, elevation: locElevation)
            let initSpeed = SpeedReading(time: currentTime, speed: currentSpeed * 2.23694)
            lastSignificantElevationReading = initElev
            lastSignificantSpeedReading = initSpeed
            DispatchQueue.main.async {
                self.elevationReadings.append(initElev)
                self.speedReadings.append(initSpeed)
            }
        }

        lastDistanceLocation = location
    }
}

// MARK: - CLLocationManagerDelegate
extension JourneyRecorder: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard !paused else { return }

        var validatedLocations: [CLLocation] = []

        for loc in locations {
            guard loc.horizontalAccuracy >= 0 && loc.horizontalAccuracy <= minAccuracy else {
                continue
            }

            let isValid = isValidLocation(loc)

            if isValid {
                validLocationCount += 1

                if let lastValid = lastValidLocation {
                    let distance = loc.distance(from: lastValid)
                    let timeInterval = loc.timestamp.timeIntervalSince(lastValid.timestamp)
                    if timeInterval > 0.1 && timeInterval < 30.0 {
                        let impliedSpeed = distance / timeInterval
                        if impliedSpeed <= maxReasonableSpeed {
                            updateSpeedHistory(with: impliedSpeed)
                        }
                    }
                }

                lastValidLocation = loc
                validatedLocations.append(loc)
            }
        }

        // Update GPS state and latest location from any valid location
        if let loc = validatedLocations.last ?? locations.last {
            DispatchQueue.main.async {
                self.gpsConnected = true
                self.gpsAccuracy = loc.horizontalAccuracy
                self.obtainedGPS = true
                self.latestLocation = self.lastValidLocation ?? loc
                self.currentElevation = loc.altitude
            }
        }

        // Update geocoding
        if let loc = validatedLocations.last {
            updateLocationName(for: loc)
        }

        // Elevation safety check
        if let loc = validatedLocations.last {
            let speedThreshold = 100 * 0.44704
            if loc.speed < speedThreshold {
                elevationSafetyNotification(elevation: loc.altitude)
            }
        }

        // Waypoint calculation
        if calculatingWaypoint, let loc = validatedLocations.last {
            handleWaypointCalculation(location: loc)
        }

        // Update bearing
        updateBearingForWaypoint()

        // Clean up old suspicious locations
        let suspiciousCutoff = Date().addingTimeInterval(-suspiciousWindowSeconds * 2)
        suspiciousLocations = suspiciousLocations.filter { $0.timestamp >= suspiciousCutoff }

        // Add validated locations to recent window
        let cutoff = Date().addingTimeInterval(-windowSeconds)
        recent = recent.filter { $0.timestamp >= cutoff }
        for loc in validatedLocations {
            if recent.count >= maxRecentLocations {
                recent.removeFirst()
            }
            recent.append(loc)
        }

        // Compute smoothed speed
        let speeds = recent.map(\.speed).filter { $0 >= 0 }
        let avgSpeed = speeds.isEmpty ? 0 : speeds.reduce(0, +) / Double(speeds.count)

        DispatchQueue.main.async {
            self.currentSpeedMps = max(avgSpeed, 0)
        }

        // Auto-start REMOVED — second_journey uses manual start via StartScreen button

        // DURING recording: write validated locations & evaluate STOP
        if isRecording {
            for loc in validatedLocations {
                // Update metrics (speed, elevation, distance)
                updateMetrics(with: loc)
                // Write to CSV
                write(loc)
            }

            // Auto-stop: 60s stationary detection
            var netDisp: CLLocationDistance = 0
            if let first = recent.first, let last = recent.last {
                netDisp = last.distance(from: first)
            }
            let maybeStop = (avgSpeed <= stopSpeed) && (netDisp <= stopDisplacement)
            if maybeStop {
                if stopCandidateBegan == nil { stopCandidateBegan = Date() }
                if let began = stopCandidateBegan, Date().timeIntervalSince(began) >= 60 {
                    stopRecording()
                    stopCandidateBegan = nil
                }
            } else {
                stopCandidateBegan = nil
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard !paused else { return }
        if recalibratingCompass {
            calibrationReadings.append(newHeading.trueHeading)
        } else {
            DispatchQueue.main.async {
                self.userHeading = newHeading.trueHeading
                self.heading = newHeading.trueHeading
            }
            updateBearingForWaypoint()
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        DispatchQueue.main.async {
            self.gpsConnected = false
            self.gpsAccuracy = nil
        }
    }
}

// MARK: - HK Delegates
extension JourneyRecorder: HKWorkoutSessionDelegate {
    func workoutSession(_ workoutSession: HKWorkoutSession,
                        didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState,
                        date: Date) {}
    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {}
}

extension JourneyRecorder: HKLiveWorkoutBuilderDelegate {
    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder,
                        didCollectDataOf collectedTypes: Set<HKSampleType>) {}
    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
}
