import SwiftUI
import CoreLocation
import Combine
import UserNotifications

class LocationManager: NSObject, ObservableObject {
    // Core Location Manager
    private var locationManager: CLLocationManager!
    @Published var gpsConnected = false
    @Published var gpsAccuracy: CLLocationAccuracy?
    @Published var obtainedGPS = false
    
    // Location Tracking
    @Published var lastLocation: CLLocation?
    @Published var latestLocation: CLLocation?
    private var lastGeocodedLocation: CLLocation?
    private let minimumDistanceForGeocoding: CLLocationDistance = 1000 // 1 km
    @Published var currentLocationName: String = ""
    @Published var currentCountyName: String = ""
    
    // Recording State
    @Published var recording = false
    @Published var startTime: Date?
    @Published var paused: Bool = false
    private var timer: Timer?
    private var pauseStartTime: Date?
    private var totalPausedTime: TimeInterval = 0
    
    // Distance and Time
    @Published var distance = 0.0
    @Published var totalTime = 0.0
    @Published var totalTimeTimer: Int = 0
    
    // Speed
    @Published var speed = 0.0
    @Published var topSpeed: Double = 0.0
    @Published var averageSpeed: Double = 0.0
    @Published var speedReadings: [SpeedReading] = []
    
    // Elevation
    @Published var currentElevation: Double = 0.0
    @Published var elevationReadings: [ElevationReading] = []
    @Published var moderateAltitudeNotificationSent = false
    @Published var highAltitudeNotificationSent = false
    
    // Heading and Compass
    @Published var userHeading: Double = 0.0
    @Published var heading: Double = 0
    @Published var recalibratingCompass = false
    private var calibrationReadings: [Double] = []
    private let calibrationDuration: TimeInterval = 20
    
    // Waypoints
    private var waypointLocations: [CLLocation] = []
    private var waypointCompletion: ((CLLocation?) -> Void)?
    @Published var calculatingWaypoint = false
    @Published var averagedWaypointLocation: CLLocation?
    @Published var bearingToWaypoint: Double = 0
    
    // Acceleration
    @Published var accelerationReadings: [Double] = []
    private let significantElevationChange: Double = 5.0 // 5 meters
    private let significantSpeedChange: Double = 2.23694 // 5 mph in m/s
    private let significantAccelerationChange: Double = 0.2 // 0.2 m/s^2
    private let minTimeBetweenReadings: TimeInterval = 10 // 10 seconds
    private var lastSignificantElevationReading: ElevationReading?
    private var lastSignificantSpeedReading: SpeedReading?
    private var lastLocationNameUpdateTime: Date?
    
    // MARK: - Initialization
    override init() {
        super.init()
        setupLocationManager()
        
    }
    
    private func setupLocationManager() {
        locationManager = CLLocationManager()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.requestAlwaysAuthorization()
        locationManager.startUpdatingLocation()
        
        if CLLocationManager.headingAvailable() {
            locationManager.startUpdatingHeading()
        }
    }
    
    // MARK: - Public Methods
    func startRecording() {
        recording = true
        startTime = Date()
        totalTimeTimer = 0
        
        resetMetrics()
        locationManager.startUpdatingLocation()
        setupTimer()
        if let initialLocation = locationManager.location {
            recordElevationReading(elevation: initialLocation.altitude)
        }
    }
    
    func stopRecording() {
        recording = false
        locationManager.stopUpdatingLocation()
        stopTimer()
    }
    
    func startWaypointCalculation() {
        calculatingWaypoint = true
        waypointLocations.removeAll()
        locationManager.requestLocation()
    }
    
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
    
    // Calculate the average heading, then update the heading
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
    
    
    func refreshGPS() {
        locationManager.stopUpdatingLocation()
        locationManager.startUpdatingLocation()
    }
    
    func updateElevation() {
        if let validLastLocation = lastLocation {
            currentElevation = validLastLocation.altitude
        }
    }
    
    func averageWaypointLocation(completion: @escaping (CLLocation?) -> Void) {
        guard waypointLocations.isEmpty else { return }
        print("Obtaining location for waypoint...")
        waypointLocations.removeAll()
        waypointCompletion = completion
        freshLocation()
    }
    
    private func freshLocation() {
        self.locationManager.requestLocation()
    }
    
    // MARK: - Private Methods
    private func resetMetrics() {
        distance = 0.0
        totalTime = 0.0
        topSpeed = 0.0
        averageSpeed = 0.0
        accelerationReadings.removeAll()
        elevationReadings.removeAll()
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
    
    func togglePause() {
        paused.toggle()
        if paused {
            pauseStartTime = Date()
            stopTimer()
            locationManager.stopUpdatingLocation()
            locationManager.stopUpdatingHeading()
        } else {
            if let pauseStart = pauseStartTime {
                totalPausedTime += Date().timeIntervalSince(pauseStart)
            }
            pauseStartTime = nil
            setupTimer()
            locationManager.startUpdatingLocation()
            locationManager.startUpdatingHeading()
        }
    }
    
    private func setupTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, !self.paused else { return }
            self.totalTimeTimer += 1
        }
    }
    
    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }
    
    private func updateLocationName(for location: CLLocation) {
        let currentTime = Date()
        
        // Check if a minute has passed since the last update
        if let lastUpdateTime = lastLocationNameUpdateTime,
           currentTime.timeIntervalSince(lastUpdateTime) < 60 {
            return // Less than a minute has passed, don't update
        }
        
        // Check if we've moved far enough to warrant a new geocoding
        if let lastLocation = lastGeocodedLocation,
           location.distance(from: lastLocation) < minimumDistanceForGeocoding {
            return // We haven't moved far enough, no need to update
        }

        // We've moved far enough and it's been at least a minute, so update the location name
        location.fetchCityAndState { [weak self] locationName, countyName in
            DispatchQueue.main.async {
                self?.currentLocationName = locationName ?? ""
                self?.currentCountyName = countyName ?? ""
                self?.lastGeocodedLocation = location
                self?.lastLocationNameUpdateTime = currentTime
            }
        }
    }
    
    private func updateBearingforWaypoint() {
        guard let currentLocation = lastLocation,
              let waypointLocation = averagedWaypointLocation else {
            bearingToWaypoint = 0
            return
        }
        
        let bearingFromNorth = currentLocation.bearing(to: waypointLocation)
        let relativeBearing = bearingFromNorth - userHeading
        bearingToWaypoint = relativeBearing >= 0 ? relativeBearing : 360 + relativeBearing
    }
    
    private func elevationSafetyNotification(elevation: Double) {
        let moderateAltitude = 2438.0
        let highAltitude = 3657.0
        
        if elevation > moderateAltitude && elevation <= highAltitude {
            sendNotification(title: "Altitude Alert", message: "You're at a high altitude. Oxygen levels may be lower than usual.")
        } else if elevation > highAltitude {
            sendNotification(title: "Altitude Alert", message: "You're at a very high altitude. Please be cautious of lower oxygen levels and potential altitude sickness.")
        }
    }
    
    private func sendNotification(title: String, message: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default
        
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                print("Error sending notification: \(error.localizedDescription)")
            }
        }
    }
    
    private func recordElevationReading(elevation: Double) {
        let newReading = ElevationReading(time: Date(), elevation: elevation)
        elevationReadings.append(newReading)
    }
}

// MARK: - CLLocationManagerDelegate
extension LocationManager: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard !paused, let location = locations.last else { return }
        print("Latitude: \(location.coordinate.latitude), Longitude: \(location.coordinate.longitude) Speed: \(location.speed) m/s")
        latestLocation = location
        gpsConnected = true
        gpsAccuracy = location.horizontalAccuracy
        obtainedGPS = true
        updateMetrics(with: location)
        updateLocationName(for: location)
        
        let speedThreshold = 100 * 0.44704 // ~100 mph in m/s
        if location.speed < speedThreshold {
            elevationSafetyNotification(elevation: location.altitude)
        }
        
        if calculatingWaypoint {
            handleWaypointCalculation(location: location)
        }
        
        // Record acceleration
        if let lastLocation = self.lastLocation {
            let timeInterval = location.timestamp.timeIntervalSince(lastLocation.timestamp)
            let speedChange = max(location.speed, 0) - max(lastLocation.speed, 0)
            let acceleration = speedChange / timeInterval
            accelerationReadings.append(acceleration)
        }
        
        self.lastLocation = location
        
        // Update bearing after setting lastLocation
        updateBearingforWaypoint()
    }
    
    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard !paused else { return }
        if recalibratingCompass {
            calibrationReadings.append(newHeading.trueHeading)
        } else {
            userHeading = newHeading.trueHeading
            heading = newHeading.trueHeading
            updateBearingforWaypoint()
        }
    }
    
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        gpsConnected = false
        gpsAccuracy = nil
        obtainedGPS = false
        print("Location Manager Error: \(error.localizedDescription)")
    }
    
    private func updateMetrics(with location: CLLocation) {
        guard !paused, recording else { return }
        
        let currentTime = location.timestamp
        let currentElevation = location.altitude
        let currentSpeed = max(location.speed, 0)
        
        if let lastLocation = self.lastLocation {
            let timeInterval = currentTime.timeIntervalSince(lastLocation.timestamp)
            
            // Update basic metrics
            if currentSpeed > 0.4 {
                let newDistance = location.distance(from: lastLocation)
                distance += newDistance * 0.00062137
                topSpeed = max(topSpeed, currentSpeed * 2.23694)
                totalTime += timeInterval
                averageSpeed = distance / (totalTime / 3600)
            }
            
            // Update elevation readings
            if let lastReading = lastSignificantElevationReading {
                let elevationChange = abs(currentElevation - lastReading.elevation)
                let timeChange = currentTime.timeIntervalSince(lastReading.time)
                
                if elevationChange >= significantElevationChange || timeChange >= minTimeBetweenReadings {
                    let newReading = ElevationReading(time: currentTime, elevation: currentElevation)
                    elevationReadings.append(newReading)
                    lastSignificantElevationReading = newReading
                }
            } else {
                let newReading = ElevationReading(time: currentTime, elevation: currentElevation)
                elevationReadings.append(newReading)
                lastSignificantElevationReading = newReading
            }
            
            // Update speed readings
            if let lastReading = lastSignificantSpeedReading {
                let speedChange = abs(currentSpeed - lastReading.speed)
                let timeChange = currentTime.timeIntervalSince(lastReading.time)
                
                if speedChange >= significantSpeedChange || timeChange >= minTimeBetweenReadings {
                    let newReading = SpeedReading(time: currentTime, speed: max(currentSpeed * 2.23694, 0))
                    speedReadings.append(newReading)
                    lastSignificantSpeedReading = newReading
                }
            } else {
                let newReading = SpeedReading(time: currentTime, speed: max(currentSpeed * 2.23694, 0))
                speedReadings.append(newReading)
                lastSignificantSpeedReading = newReading
            }
            
            // Update acceleration readings
            if timeInterval > 0 {
                let speedChange = currentSpeed - lastLocation.speed
                let currentAcceleration = speedChange / timeInterval
                
                if currentAcceleration.isFinite && (accelerationReadings.isEmpty || abs(currentAcceleration) >= significantAccelerationChange || timeInterval >= minTimeBetweenReadings) {
                    accelerationReadings.append(currentAcceleration)
                    
                    // Debug print
                    print("Acceleration: \(currentAcceleration), Speed change: \(speedChange), Time interval: \(timeInterval)")
                }
            }
        } else {
            // First reading
            lastSignificantElevationReading = ElevationReading(time: currentTime, elevation: currentElevation)
            lastSignificantSpeedReading = SpeedReading(time: currentTime, speed: currentSpeed * 2.23694)
            elevationReadings.append(lastSignificantElevationReading!)
            speedReadings.append(lastSignificantSpeedReading!)
            accelerationReadings.append(0)
        }
        
        self.lastLocation = location
        self.speed = max(currentSpeed * 2.23694, 0)
        self.currentElevation = currentElevation
        
        DispatchQueue.main.async {
            self.objectWillChange.send()
        }
    }
    
    private func handleWaypointCalculation(location: CLLocation) {
        if waypointLocations.count < 3 {
            if location.horizontalAccuracy <= 5.0 {
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
            
            // Update bearing after setting averagedWaypointLocation
            updateBearingforWaypoint()
        }
    }
}

// MARK: - CLLocation Extension
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

struct ElevationReading: Equatable {
    var time: Date
    var elevation: Double
    
    static func == (lhs: ElevationReading, rhs: ElevationReading) -> Bool {
        return lhs.time == rhs.time && lhs.elevation == rhs.elevation
    }
}

struct AccelerationReading: Equatable {
    var time: Date
    var acceleration: Double
    
    static func == (lhs: AccelerationReading, rhs: AccelerationReading) -> Bool {
        return lhs.time == rhs.time && lhs.acceleration == rhs.acceleration
    }
}

struct SpeedReading: Equatable {
    var time: Date
    var speed: Double
    
    static func == (lhs: SpeedReading, rhs: SpeedReading) -> Bool {
        return lhs.time == rhs.time && lhs.speed == rhs.speed
    }
}
