import SwiftUI
import CoreLocation
import Combine
import UserNotifications

class LocationManager: NSObject, ObservableObject {
    // MARK: - Properties
    private var locationManager: CLLocationManager!
    private var startTime: Date?
    private var timer: Timer?
    private var waypointLocations: [CLLocation] = []
    private var waypointCompletion: ((CLLocation?) -> Void)?
    var lastLocation: CLLocation?
    private var totalSpeedReadings: Double = 0.0
    private var numberOfSpeedReadings: Int = 0
    private var lastGeocodedLocation: CLLocation?
    private let minimumDistanceForGeocoding: CLLocationDistance = 1000 // 1 km
    
    // Published properties
    @Published var recording = false
    @Published var distance = 0.0
    @Published var totalTime = 0.0
    @Published var speed = 0.0
    @Published var gpsConnected = false
    @Published var gpsAccuracy: CLLocationAccuracy?
    @Published var topSpeed: Double = 0.0
    @Published var averageSpeed: Double = 0.0
    @Published var currentElevation: Double = 0.0
    @Published var currentLocationName: String = ""
    @Published var currentCountyName: String = ""
    @Published var latestLocation: CLLocation?
    @Published var userHeading: Double = 0.0
    @Published var isRecalibrating = false
    @Published var totalTimeTimer: Int = 0
    @Published var obtainedGPS = false
    @Published var accelerationReadings: [Double] = []
    @Published var isCalculatingWaypoint = false
    @Published var averagedWaypointLocation: CLLocation?
    @Published var heading: Double = 0
    @Published var elevationReadings: [ElevationReading] = []
    @Published var moderateAltitudeNotificationSent = false
    @Published var highAltitudeNotificationSent = false
    @Published var bearingToWaypoint: Double = 0
    private var calibrationReadings: [Double] = []
    private let calibrationDuration: TimeInterval = 20
    
    @Published var isPaused: Bool = false
        private var pauseStartTime: Date?
        private var totalPausedTime: TimeInterval = 0
    
    
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
        isCalculatingWaypoint = true
        waypointLocations.removeAll()
        locationManager.requestLocation()
    }
    
    func recalibrateCompass() {
        guard CLLocationManager.headingAvailable() else { return }
        
        isRecalibrating = true
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
            isRecalibrating = false
            return
        }
        let averageHeading = calibrationReadings.reduce(0, +) / Double(calibrationReadings.count)
        heading = averageHeading
        userHeading = averageHeading
        isRecalibrating = false
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
        totalSpeedReadings = 0.0
        numberOfSpeedReadings = 0
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
            isPaused.toggle()
            if isPaused {
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
                guard let self = self, !self.isPaused else { return }
                self.totalTimeTimer += 1
                print("Elapsed Time: \(self.totalTimeTimer)")
            }
        }
    
    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }
    
    private func updateLocationName(for location: CLLocation) {
        // Check if we've moved far enough to warrant a new geocoding
        if let lastLocation = lastGeocodedLocation,
           location.distance(from: lastLocation) < minimumDistanceForGeocoding {
            return // We haven't moved far enough, no need to update
        }
        
        // We've moved far enough, so update the location name
        location.fetchCityAndState { [weak self] locationName, countyName in
            DispatchQueue.main.async {
                self?.currentLocationName = locationName ?? ""
                self?.currentCountyName = countyName ?? ""
                self?.lastGeocodedLocation = location
            }
        }
    }
    
    private func updateBearingToWaypoint() {
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
            sendNotification(title: "Altitude Alert", message: "You are at a high altitude. Oxygen levels may be lower than usual.")
        } else if elevation > highAltitude {
            sendNotification(title: "Altitude Alert", message: "You are at a very high altitude. Please be cautious of lower oxygen levels and potential altitude sickness.")
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
        guard !isPaused, let location = locations.last else { return }
        
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
        
        if isCalculatingWaypoint {
            handleWaypointCalculation(location: location)
        }
        
        // Record acceleration
        if let lastLocation = self.lastLocation {
            let timeInterval = location.timestamp.timeIntervalSince(lastLocation.timestamp)
            let speedChange = location.speed - lastLocation.speed
            let acceleration = speedChange / timeInterval
            accelerationReadings.append(acceleration)
        }
        
        self.lastLocation = location
        
        // Update bearing after setting lastLocation
        updateBearingToWaypoint()
    }
    
    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard !isPaused else { return }
        if isRecalibrating {
            calibrationReadings.append(newHeading.trueHeading)
        } else {
            userHeading = newHeading.trueHeading
            heading = newHeading.trueHeading
            updateBearingToWaypoint()
        }
    }
    
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        gpsConnected = false
        gpsAccuracy = nil
        obtainedGPS = false
        print("Location Manager Error: \(error.localizedDescription)")
    }
    
    private func updateMetrics(with location: CLLocation) {
        guard !isPaused else { return }
        if recording, let lastLocation = self.lastLocation {
            let newSpeed = location.speed * 2.23694 // Convert to mph
            speed = max(0, newSpeed)
            
            if speed > 0.5 {
                let newDistance = location.distance(from: lastLocation)
                distance += newDistance * 0.00062137 // Convert to miles
            }
            
            topSpeed = max(topSpeed, speed)
            
            totalSpeedReadings += speed
            numberOfSpeedReadings += 1
            averageSpeed = totalSpeedReadings / Double(numberOfSpeedReadings)
            
            if elevationReadings.isEmpty {
                recordElevationReading(elevation: location.altitude)
            } else {
                let elevationChangeThreshold = 1.0
                if abs(location.altitude - lastLocation.altitude) > elevationChangeThreshold {
                    recordElevationReading(elevation: location.altitude)
                }
            }
            
            currentElevation = location.altitude
        }
    }
    
    private func handleWaypointCalculation(location: CLLocation) {
        if waypointLocations.count < 3 {
            waypointLocations.append(location)
        } else {
            let averageLat = waypointLocations.map { $0.coordinate.latitude }.reduce(0, +) / Double(waypointLocations.count)
            let averageLon = waypointLocations.map { $0.coordinate.longitude }.reduce(0, +) / Double(waypointLocations.count)
            averagedWaypointLocation = CLLocation(latitude: averageLat, longitude: averageLon)
            
            waypointCompletion?(averagedWaypointLocation)
            waypointLocations.removeAll()
            isCalculatingWaypoint = false
            
            // Update bearing after setting averagedWaypointLocation
            updateBearingToWaypoint()
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

struct ElevationReading {
    var time: Date
    var elevation: Double
}
