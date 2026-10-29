import Foundation
import UIKit
import CoreLocation
import Combine
import ZIPFoundation
import os.log

@Observable
final class LocationService: NSObject {
    // MARK: - Recording State
    var isRecording = false
    var duration: TimeInterval = 0
    var totalSeconds: Int = 0
    var pointCount = 0

    // MARK: - Metrics
    var distanceMeters: CLLocationDistance = 0
    var currentSpeedMps: CLLocationSpeed = 0
    var topSpeedMph: Double = 0
    var averageSpeedMph: Double = 0

    // MARK: - Location
    var latestLocation: CLLocation?
    var routeCoordinates: [CLLocationCoordinate2D] = []
    var gpsConnected = false
    var gpsAccuracy: CLLocationAccuracy?

    // MARK: - Computed
    var distanceMiles: Double { distanceMeters / 1609.344 }
    var currentSpeedMph: Double { max(currentSpeedMps * 2.23694, 0) }

    // MARK: - Private: Location Manager
    private let locationManager = CLLocationManager()
    private var lastDistanceLocation: CLLocation?

    // MARK: - Private: Motion Window
    private var recent: [CLLocation] = []
    private let windowSeconds: TimeInterval = 10
    private let maxRecentLocations = 100

    // MARK: - Private: GPS Spike Filtering (7-layer, ported from watch)
    private var lastValidLocation: CLLocation?
    private let maxReasonableSpeed: CLLocationSpeed = 4000000000.0
    private let maxAcceleration: Double = 5000000000.0
    private let minAccuracy: CLLocationAccuracy = 500000000.0
    private var recentValidSpeeds: [CLLocationSpeed] = []
    private let speedHistoryCount = 10
    private var validLocationCount = 0
    private let warmupLocationCount = 5

    // MARK: - Private: Recording Artifacts
    private var csvURL: URL?
    private var zipURL: URL?
    private var fileHandle: FileHandle?
    private var recordingStartTime: Date?
    private var updateTimer: Timer?
    private var writeCounter = 0
    private var backgroundActivitySession: CLBackgroundActivitySession?
    private let liveActivityManager = LiveActivityManager.shared
    private var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid
    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Journey", category: "LocationService")

    // MARK: - Init
    override init() {
        super.init()
        locationManager.delegate = self
        configureLocationManagerForCurrentState()
        updateBackgroundLocationConfiguration()
        requestLocationAuthorizationIfNeeded()
    }

    private func requestLocationAuthorizationIfNeeded() {
        switch locationManager.authorizationStatus {
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            locationManager.startUpdatingLocation()
        default:
            break
        }
    }

    private func updateBackgroundLocationConfiguration() {
        let isAuthorizedForLocation: Bool
        switch locationManager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            isAuthorizedForLocation = true
        default:
            isAuthorizedForLocation = false
        }
        let canUseBackgroundLocation = hasBackgroundLocationMode && isAuthorizedForLocation && isRecording

        // Core Location asserts if background updates are enabled before the app is eligible for them.
        locationManager.showsBackgroundLocationIndicator = canUseBackgroundLocation
        locationManager.allowsBackgroundLocationUpdates = canUseBackgroundLocation
    }

    private func configureLocationManagerForCurrentState() {
        if isRecording {
            locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
            locationManager.distanceFilter = kCLDistanceFilterNone
            locationManager.activityType = .otherNavigation
            locationManager.pausesLocationUpdatesAutomatically = false
        } else {
            locationManager.desiredAccuracy = kCLLocationAccuracyBest
            locationManager.distanceFilter = 5
            locationManager.activityType = .automotiveNavigation
            locationManager.pausesLocationUpdatesAutomatically = true
        }
    }

    private func requestBackgroundRecordingAuthorizationIfNeeded() {
        switch locationManager.authorizationStatus {
        case .authorizedWhenInUse:
            locationManager.requestAlwaysAuthorization()
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        default:
            break
        }
    }

    private func startBackgroundRecordingSessionIfNeeded() {
        guard isRecording else { return }
        if backgroundActivitySession == nil {
            backgroundActivitySession = CLBackgroundActivitySession()
        }
    }

    private func stopBackgroundRecordingSession() {
        backgroundActivitySession?.invalidate()
        backgroundActivitySession = nil
    }

    private func refreshElapsedTime() {
        guard isRecording, let start = recordingStartTime else { return }
        let elapsed = Date().timeIntervalSince(start)
        duration = elapsed
        totalSeconds = Int(elapsed)
    }

    func appDidEnterBackground() {
        guard isRecording else { return }
        Self.log.info("Entering background while recording — ensuring continuous updates")

        // Request extra background execution time during the transition
        endBackgroundTaskIfNeeded()
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "JourneyRecording") { [weak self] in
            self?.endBackgroundTaskIfNeeded()
        }

        updateBackgroundLocationConfiguration()
        startBackgroundRecordingSessionIfNeeded()
        locationManager.startUpdatingLocation()
        try? fileHandle?.synchronize()
        refreshElapsedTime()
    }

    func appDidBecomeActive() {
        endBackgroundTaskIfNeeded()
        guard isRecording else { return }
        Self.log.info("Returning to foreground while recording — restarting updates")
        updateBackgroundLocationConfiguration()
        locationManager.startUpdatingLocation()
        refreshElapsedTime()
    }

    private func endBackgroundTaskIfNeeded() {
        guard backgroundTaskID != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTaskID)
        backgroundTaskID = .invalid
    }

    private var hasBackgroundLocationMode: Bool {
        let rawValue = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes")

        if let modes = rawValue as? [String] {
            return modes.contains("location")
        }
        if let mode = rawValue as? String {
            return mode.split(separator: " ").contains("location")
        }

        return false
    }

    // MARK: - Public Controls

    func startRecording() {
        guard !isRecording else { return }

        // Prepare CSV
        let fileName = "route_\(Int64(Date().timeIntervalSince1970 * 1000)).csv"
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        csvURL = docs.appendingPathComponent(fileName)
        zipURL = csvURL!.deletingPathExtension().appendingPathExtension("zip")
        let header = "ts_ms,lat,lon,ele_m,speed_ms,waypoint,note\n"
        FileManager.default.createFile(atPath: csvURL!.path, contents: Data(header.utf8))
        fileHandle = try? FileHandle(forWritingTo: csvURL!)
        _ = try? fileHandle?.seekToEnd()

        // Reset state
        isRecording = true
        pointCount = 0
        writeCounter = 0
        recordingStartTime = Date()
        duration = 0
        totalSeconds = 0
        distanceMeters = 0
        lastDistanceLocation = nil
        currentSpeedMps = 0
        topSpeedMph = 0
        averageSpeedMph = 0
        routeCoordinates.removeAll()
        recent.removeAll()

        // Reset GPS filtering
        lastValidLocation = nil
        recentValidSpeeds.removeAll()
        validLocationCount = 0

        if let startingLocation = latestLocation ?? locationManager.location,
           startingLocation.horizontalAccuracy >= 0,
           startingLocation.horizontalAccuracy <= minAccuracy {
            latestLocation = startingLocation
            lastDistanceLocation = startingLocation
            routeCoordinates = [startingLocation.coordinate]
            currentSpeedMps = max(startingLocation.speed, 0)
        }

        configureLocationManagerForCurrentState()
        requestBackgroundRecordingAuthorizationIfNeeded()
        updateBackgroundLocationConfiguration()
        startBackgroundRecordingSessionIfNeeded()

        if let recordingStartTime {
            liveActivityManager.start(
                startedAt: recordingStartTime,
                gpsConnected: gpsConnected
            )
        }

        // Ensure location updates
        locationManager.startUpdatingLocation()

        // Timer for elapsed time — add to .common mode so it fires in background
        updateTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self, let start = self.recordingStartTime else { return }
            let elapsed = Date().timeIntervalSince(start)
            self.duration = elapsed
            self.totalSeconds = Int(elapsed)
        }
        RunLoop.main.add(timer, forMode: .common)
        updateTimer = timer

        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    }

    /// Stops recording and returns the ZIP file URL for upload
    func stopRecording() -> URL? {
        guard isRecording else { return nil }

        let finalRecordingStartTime = recordingStartTime ?? Date()
        let finalDistanceMiles = distanceMiles
        let finalSpeedMph = currentSpeedMph
        let finalPointCount = pointCount

        updateTimer?.invalidate()
        updateTimer = nil

        // Flush and close CSV
        try? fileHandle?.synchronize()
        try? fileHandle?.close()
        fileHandle = nil

        // Create ZIP
        var resultURL: URL?
        if let csvURL, let zipURL {
            createZip(from: csvURL, to: zipURL)
            try? FileManager.default.removeItem(at: csvURL)
            resultURL = zipURL
        }

        // Reset
        isRecording = false
        recordingStartTime = nil
        duration = 0
        totalSeconds = 0
        pointCount = 0
        distanceMeters = 0
        topSpeedMph = 0
        averageSpeedMph = 0
        routeCoordinates.removeAll()
        csvURL = nil
        zipURL = nil
        recent.removeAll()
        lastDistanceLocation = nil
        lastValidLocation = nil
        recentValidSpeeds.removeAll()
        validLocationCount = 0
        currentSpeedMps = 0
        stopBackgroundRecordingSession()
        endBackgroundTaskIfNeeded()
        configureLocationManagerForCurrentState()
        updateBackgroundLocationConfiguration()
        liveActivityManager.end(
            startedAt: finalRecordingStartTime,
            distanceMiles: finalDistanceMiles,
            speedMph: finalSpeedMph,
            pointCount: finalPointCount
        )

        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()

        return resultURL
    }

    // MARK: - GPS Spike Filtering (7-layer, ported from watch JourneyRecorder)

    private func isValidLocation(_ location: CLLocation) -> Bool {
        // Layer 1: Horizontal accuracy
        guard location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= minAccuracy else {
            return false
        }
        // Layer 2: Coordinate bounds
        guard abs(location.coordinate.latitude) <= 90,
              abs(location.coordinate.longitude) <= 180 else {
            return false
        }
        // Layer 3: Vertical accuracy
        if location.verticalAccuracy >= 0 && location.verticalAccuracy > 100 {
            return false
        }
        // First location is always valid
        guard let lastValid = lastValidLocation else {
            return true
        }
        let distance = location.distance(from: lastValid)
        let timeInterval = location.timestamp.timeIntervalSince(lastValid.timestamp)
        // Layer 4: Time interval validation
        guard timeInterval > 0.1 else { return false }
        guard timeInterval < 30.0 else {
            validLocationCount = 0
            recentValidSpeeds.removeAll()
            return true
        }
        let impliedSpeed = distance / timeInterval
        // Warmup: less strict during first N locations
        if validLocationCount < warmupLocationCount {
            if impliedSpeed > maxReasonableSpeed { return false }
            return true
        }
        // Layer 5: Max speed check
        if impliedSpeed > maxReasonableSpeed {
            return false
        }
        // Layer 6: Reported vs implied speed
        if location.speed >= 0 {
            let reportedSpeed = location.speed
            if reportedSpeed < 5.0 && impliedSpeed > 15.0 {
                return false
            }
            let speedDiff = abs(reportedSpeed - impliedSpeed)
            if speedDiff > max(20.0, max(reportedSpeed, impliedSpeed) * 0.7) {
                return false
            }
        }
        // Layer 7: Acceleration + speed history
        if !recentValidSpeeds.isEmpty {
            let avgRecentSpeed = recentValidSpeeds.reduce(0, +) / Double(recentValidSpeeds.count)
            let maxRecentSpeed = recentValidSpeeds.max() ?? 0
            let acceleration = (impliedSpeed - avgRecentSpeed) / timeInterval
            if abs(acceleration) > maxAcceleration {
                if !isConsistentAcceleration(impliedSpeed: impliedSpeed) {
                    return false
                }
            }
            if impliedSpeed > maxRecentSpeed * 2.5 && impliedSpeed > 10.0 {
                return false
            }
        }
        // Accuracy degradation check
        if location.horizontalAccuracy > lastValid.horizontalAccuracy * 3.0 {
            if impliedSpeed > 10.0 {
                return false
            }
        }
        return true
    }

    private func isConsistentAcceleration(impliedSpeed: CLLocationSpeed) -> Bool {
        guard recentValidSpeeds.count >= 4 else { return false }
        var increases = 0
        for i in 0..<(recentValidSpeeds.count - 1) {
            if recentValidSpeeds[i+1] > recentValidSpeeds[i] { increases += 1 }
        }
        let increasingRatio = Double(increases) / Double(recentValidSpeeds.count - 1)
        if increasingRatio >= 0.75 { return true }
        return recentValidSpeeds.allSatisfy { $0 > 15.0 }
    }

    private func updateSpeedHistory(with speed: CLLocationSpeed) {
        recentValidSpeeds.append(speed)
        if recentValidSpeeds.count > speedHistoryCount {
            recentValidSpeeds.removeFirst()
        }
    }

    // MARK: - CSV Write

    private func writeCSV(_ loc: CLLocation) {
        guard let h = fileHandle else { return }
        let ts = Int64(loc.timestamp.timeIntervalSince1970 * 1000)
        let lat = loc.coordinate.latitude
        let lon = loc.coordinate.longitude
        let ele = loc.altitude
        let speed = max(loc.speed, 0)
        if let data = "\(ts),\(lat),\(lon),\(ele),\(speed),,\n".data(using: .utf8) {
            try? h.write(contentsOf: data)
            pointCount += 1
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
            print("ZIP creation failed: \(error)")
        }
    }

    // MARK: - Metrics Update

    private func updateMetrics(with location: CLLocation) {
        guard isRecording else { return }
        let currentSpeed = max(location.speed, 0)

        // Update speed
        currentSpeedMps = currentSpeed

        if let lastLoc = lastDistanceLocation {
            // Distance (only count movement > 0.4 m/s, segments < 1000m)
            if currentSpeed > 0.4 {
                let newDistance = location.distance(from: lastLoc)
                if newDistance.isFinite && newDistance >= 0 && newDistance < 1000 {
                    distanceMeters += newDistance
                    topSpeedMph = max(topSpeedMph, currentSpeed * 2.23694)
                    if totalSeconds > 0 {
                        let hours = Double(totalSeconds) / 3600.0
                        if hours > 0 {
                            averageSpeedMph = distanceMiles / hours
                        }
                    }
                }
            }
        }
        lastDistanceLocation = location
    }
}

// MARK: - CLLocationManagerDelegate

extension LocationService: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        var validatedLocations: [CLLocation] = []

        for loc in locations {
            guard loc.horizontalAccuracy >= 0 && loc.horizontalAccuracy <= minAccuracy else { continue }

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

        // Update GPS state
        if let loc = validatedLocations.last ?? locations.last {
            gpsConnected = true
            gpsAccuracy = loc.horizontalAccuracy
            latestLocation = lastValidLocation ?? loc
        }

        // Update motion window
        let windowCutoff = Date().addingTimeInterval(-windowSeconds)
        recent = recent.filter { $0.timestamp >= windowCutoff }
        for loc in validatedLocations {
            if recent.count >= maxRecentLocations { recent.removeFirst() }
            recent.append(loc)
        }

        // Smoothed speed
        let speeds = recent.map(\.speed).filter { $0 >= 0 }
        if !speeds.isEmpty {
            currentSpeedMps = max(speeds.reduce(0, +) / Double(speeds.count), 0)
        }

        // During recording: write + update metrics
        if isRecording {
            refreshElapsedTime()
            for loc in validatedLocations {
                updateMetrics(with: loc)
                writeCSV(loc)
                routeCoordinates.append(loc.coordinate)
            }

            if let recordingStartTime {
                liveActivityManager.update(
                    startedAt: recordingStartTime,
                    distanceMiles: distanceMiles,
                    speedMph: currentSpeedMph,
                    pointCount: pointCount,
                    gpsConnected: gpsConnected
                )
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        gpsConnected = false
        gpsAccuracy = nil

        if isRecording, let recordingStartTime {
            liveActivityManager.update(
                startedAt: recordingStartTime,
                distanceMiles: distanceMiles,
                speedMph: currentSpeedMph,
                pointCount: pointCount,
                gpsConnected: false
            )
        }
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        Self.log.warning("System paused location updates")
        guard isRecording else { return }
        // Immediately restart — we never want pauses during a journey
        manager.stopUpdatingLocation()
        manager.startUpdatingLocation()
        Self.log.info("Restarted location updates after system pause")
    }

    func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        Self.log.info("System resumed location updates")
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        updateBackgroundLocationConfiguration()
        configureLocationManagerForCurrentState()

        if isRecording {
            startBackgroundRecordingSessionIfNeeded()
        }

        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.startUpdatingLocation()
        default:
            break
        }
    }
}
