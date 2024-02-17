// Summary: manages and monitors location-related information using the Core Location framework
import SwiftUI
import CoreLocation
import Combine
import os
import CoreMotion
import UserNotifications

// For CMAltimeter code, it's commented out - only GPS is being used for determining elevation at the moment. This means "+ relativeAltitude" property is also commented out at the moment, only here.

class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    
    private var locationManager: CLLocationManager!
    private var startTime: Date?
    var lastLocation: CLLocation?
    private var timer: Timer?
    private var totalSpeedReadings: Double = 0.0
    private var numberOfSpeedReadings: Int = 0
    @Published var isRecording = false
    @Published var distance = 0.0 // Distance in miles
    @Published var totalTime = 0.0 // Total time in seconds
    @Published var speed = 0.0 // Speed in miles per hour
    @Published var isGPSConnected = false
    @Published var gpsAccuracy: CLLocationAccuracy?
    @Published var topSpeed: Double = 0.0
    @Published var averageSpeed: Double = 0.0
    @Published var currentElevation: Double = 0.0
    @Published var currentLocationName: String = ""
    private let speedThreshold: CLLocationSpeed = 0.5 / 0.8 // Define a threshold speed (1 MPH in this instance)
    private let altimeter = CMAltimeter()  // Altimeter instance
    /*private */ var previousElevation: Double? = nil
    private var waypointLocations: [CLLocation] = []
    private var waypointCompletion: ((CLLocation?) -> Void)?
    var waypointLocation: CLLocation?
    @Published var relativeAltitude: Double = 0.0
    @Published var elevationReadings: [ElevationReading] = []
    private var lastSuccessfulLocationName: String = ""
    private let maxRetryCount = 300000000
    private var currentRetryCount = 0
    private let retryDelaySeconds = 5.0
    @Published var accelerationReadings: [Double] = []
    private var lastSpeed: CLLocationSpeed? = nil
    @Published var averagedWaypointLocation: CLLocation?
    var isCalculatingWaypoint = false
    @Published var latestLocation: CLLocation?
    @Published var userHeading: Double = 0.0
    @Published var heading: Double = 0
    @Published var lastSuccessfulCountyName: String = ""
    
    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        DispatchQueue.main.async {
            // print("New heading: \(newHeading.trueHeading)")
                self.userHeading = newHeading.trueHeading
                self.heading = newHeading.trueHeading
            }
    }
    
    func startWaypointCalculation() {
        isCalculatingWaypoint = true
        waypointLocations.removeAll()
        requestAccurateLocation()
    }
    
    func averageWaypointLocation(completion: @escaping (CLLocation?) -> Void) {
        guard waypointLocations.isEmpty else { return }
        print("Obtaining location for waypoint...")
        waypointLocations.removeAll()
        waypointCompletion = completion
        requestAccurateLocation()
    }
    
    
    private func requestAccurateLocation() {
        self.locationManager.requestLocation()
    }
    
    func startAltimeterUpdates() {
        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] (altitudeData, error) in
                if let altitudeData = altitudeData, error == nil {
                    self?.relativeAltitude = altitudeData.relativeAltitude.doubleValue
                    if let lastLocation = self?.lastLocation {
                        self?.currentElevation = lastLocation.altitude + self!.relativeAltitude
                    }
                }
            }
        }
    }
    
    func stopAltimeterUpdates() {
        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.stopRelativeAltitudeUpdates()
        }
    }
    
    func updateElevation(_ newElevation: Double) {
        self.previousElevation = currentElevation
        self.currentElevation = newElevation
    }
    
    var totalTimeText: String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute, .second]
        formatter.unitsStyle = .positional
        formatter.zeroFormattingBehavior = .pad
        return formatter.string(from: TimeInterval(totalTime)) ?? "00:00:00"
    }
    
    var totalTimeTextTimer: String {
        let totalSeconds = Int(totalTime)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        let seconds = totalSeconds % 60
        
        if hours > 0 {
            return String(format: "%01d:%02d:%02d", hours, minutes, seconds)
        } else {
            return String(format: "%02d:%02d", minutes, seconds)
        }
    }
    
    // MARK: - Initialization
    override init() {
        super.init()
        self.locationManager = CLLocationManager()
        self.locationManager.delegate = self
        self.locationManager.startUpdatingHeading()
        isGPSConnected = false
        gpsAccuracy = nil
        // Start altimeter updates if available
        /*
         if CMAltimeter.isRelativeAltitudeAvailable() {
         altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] (altitudeData, error) in
         if let altitudeData = altitudeData, error == nil {
         // Update relative altitude
         self?.relativeAltitude = altitudeData.relativeAltitude.doubleValue
         // Recalculate the current elevation using relative altitude
         if let lastLocation = self?.lastLocation {
         self?.currentElevation = lastLocation.altitude + self!.relativeAltitude
         }
         }
         }
         }
         */
        
        self.locationManager = CLLocationManager()
        self.locationManager.delegate = self
        locationManager.requestAlwaysAuthorization() // Request 'Always' authorization
        self.locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        self.locationManager.allowsBackgroundLocationUpdates = true
        self.locationManager.startUpdatingLocation()
        self.locationManager.delegate = self
        self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
        self.locationManager.requestWhenInUseAuthorization()
        // Request 'Always' authorization
        self.locationManager.requestAlwaysAuthorization()
        if CLLocationManager.headingAvailable() {
                self.locationManager.startUpdatingHeading()
            }
        
    }
    
    func startUpdatingLocation() {
        locationManager.startUpdatingLocation()
    }
    
    func stopUpdatingLocation() {
        locationManager.stopUpdatingLocation()
    }
    
    func refreshGPS() {
        stopUpdatingLocation()
        startUpdatingLocation()
        print("GPS has been refreshed") // Debug message
    }
    
    // Puts location error in human-readable format, debug purposes
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("Location Manager Error: \(error.localizedDescription)")
        print("Error Domain: \(error._domain)")
        print("Error Code: \(error._code)")
    }
    
    func startRecording() {
        stopTimer()
        print("startRecording() - Start") //print debug message
        isRecording = true
        print("startRecording() - isRecording set to true")
        startTime = Date()
        lastLocation = nil
        distance = 0.0
        totalTime = 0.0
        locationManager.startUpdatingLocation()
        
        startTimer()
        print("startRecording() - End") //print debug message
    }
    
    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }
    
    private func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                // Update elapsedTime and any other time-related properties
                if let startTime = self?.startTime {
                    self?.totalTime = Date().timeIntervalSince(startTime)
                    
                }
            }
        }
    }
    
    func stopRecording() {
        stopTimer()
        print("stopRecording() - Start") //print debug message
        isRecording = false
        print("stopRecording() - isRecording set to false") //print debug message
        locationManager.stopUpdatingLocation()
        topSpeed = 0.0
        totalSpeedReadings = 0.0
        numberOfSpeedReadings = 0
        averageSpeed = 0.0
        print("stopRecording() - End") // print debug message
    }
    
    // Observe changes in GPS accuracy
    private var cancellable: AnyCancellable?
    private func observeGPSAccuracy() {
        cancellable = $gpsAccuracy
            .sink { [weak self] accuracy in
                if accuracy == nil || accuracy! > 200 {
                    self?.refreshGPS()
                }
            }
    }
    
    func startObserving() {
        observeGPSAccuracy()
    }
    
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        guard let latestLocation = locations.last else { return }
        guard let newLocation = locations.last else { return }
        self.latestLocation = newLocation
        
        if let lastLocation = locations.last {
                   let elevation = lastLocation.altitude // Altitude in meters
                   
                   // Check elevation and send notification if needed
                   checkElevationAndNotify(elevation: elevation)
               }
          
        func checkElevationAndNotify(elevation: Double) {
            let moderateAltitude = 2438.0 // this is in meters
            let highAltitude = 3657.0
                
                var message = ""
                
                if elevation > moderateAltitude && elevation <= highAltitude {
                    message = "You are at a high altitude. Oxygen levels may be lower than usual."
                } else if elevation > highAltitude {
                    message = "You are at a very high altitude. Please exercise cautious of lower oxygen levels and potential altitude sickness."
                }
                
                if !message.isEmpty {
                    sendNotificationWith(message: message)
                }
            }
            
            func sendNotificationWith(message: String) {
                let content = UNMutableNotificationContent()
                content.title = "Altitude Alert"
                content.body = message
                content.sound = .default
                
                let request = UNNotificationRequest(identifier: "altitudeAlert", content: content, trigger: nil)
                UNUserNotificationCenter.current().add(request) { (error) in
                    if let error = error {
                        print("Error sending notification: \(error.localizedDescription)")
                    }
                }
            }
        
        print("🛰️ Received location update")
        
        if isRecording, let _ = self.lastLocation { // lastLocation
            let deltaDistance = newLocation.distance(from: self.lastLocation ?? newLocation)
            distance += deltaDistance * 0.00062137
            // Check for significant elevation change (e.g., more than 5 meters)
            let elevationChangeThreshold = 1.0
            if let lastElevation = self.lastLocation?.altitude,
               abs(newLocation.altitude - lastElevation) > elevationChangeThreshold {
                recordElevationReading(elevation: newLocation.altitude)
            }
        }
        
        self.lastLocation = newLocation
        
        debugPrint("ⓘ Current Location: (\(latestLocation.coordinate.latitude), \(latestLocation.coordinate.longitude))")
        if latestLocation.horizontalAccuracy <= 6.1 { // Accuracy of 2 meters or ~6 feet for actual best results ACCURACYINFEET
            self.lastLocation = latestLocation
            self.waypointLocations.append(latestLocation)
            debugPrint("✓ Accurate Location Reading: \(latestLocation.coordinate.latitude), \(latestLocation.coordinate.longitude)")
        } else {
            debugPrint("✖ Inaccurate location - reading skipped")
        }
        
        if isCalculatingWaypoint {
            if waypointLocations.count < 3 {
                waypointLocations.append(location)
            } else {
                let averageLat = waypointLocations.map { $0.coordinate.latitude }.average()
                let averageLon = waypointLocations.map { $0.coordinate.longitude }.average()
                let averagedLocation = CLLocation(latitude: averageLat, longitude: averageLon)
                
                debugPrint("⟟ Averaged Location: \(averagedLocation.coordinate.latitude), \(averagedLocation.coordinate.longitude)")
                waypointCompletion?(averagedLocation)
                waypointLocations.removeAll()
                isCalculatingWaypoint = false
            }
        }
        
        let currentSpeedMPS = latestLocation.speed
        let currentSpeedMPH = max(0, currentSpeedMPS) * 2.23694
        if currentSpeedMPH > 0 {
            totalSpeedReadings += currentSpeedMPH
            numberOfSpeedReadings += 1
        }
        
        if let lastLocation = locations.last {
            self.currentElevation = lastLocation.altitude
        }
        
        // print("Current Speed (MPH): \(currentSpeedMPH)") // Debugging
        if currentSpeedMPH > topSpeed {
            topSpeed = currentSpeedMPH
        }
        
        // print("Top Speed (MPH): \(topSpeed)") // Debugging
        
        let timeElapsed = Date().timeIntervalSince(startTime ?? Date())
        if numberOfSpeedReadings > 0 {
            averageSpeed = totalSpeedReadings / Double(numberOfSpeedReadings)
        }
        
        // print("Average Speed (MPH): \(averageSpeed)")
        // print("Distance: \(distance) meters")
        // print("Time Elapsed: \(timeElapsed) seconds")
        // print("Start Time: \(String(describing: startTime))")
        // print("Average Speed (MPH): \(averageSpeed)")
        
        lastLocation = latestLocation
        
        if let location = locations.last {
            location.fetchCityAndState { [weak self] locationName in
                DispatchQueue.main.async {
                    if let locationName = locationName, !locationName.isEmpty {
                        // Check if location name is in the expected format (e.g., "City, State")
                        if locationName.contains(",") {
                            print("✓ Reverse Geocoding result: \(locationName)")
                            self?.currentLocationName = locationName
                        } else {
                            // If the format is not as expected, extract only the state name
                            self?.extractState(from: location) { stateName in
                                if let stateName = stateName {
                                    print("✓ State name extracted: \(stateName)")
                                    self?.currentLocationName = stateName
                                } else {
                                    print("Reverse Geocoding failed. Keeping the last known location.")
                                    // The currentLocationName remains unchanged if the state extraction fails
                                }
                            }
                        }
                    } else {
                        // If the geocoding result fails, maintain the last known location
                        print("Reverse Geocoding failed. Keeping the last known location.")
                        // The currentLocationName remains unchanged if the geocoding fails
                    }
                }
            }

            let accuracyInMeters = location.horizontalAccuracy
            let accuracyInFeet = accuracyInMeters * 3.28084 // Convert meters to feet
            print("---- GPS Accuracy: \(String(format: "%.3f", accuracyInMeters)) meters or \(String(format: "%.3f", accuracyInFeet)) feet ----")
        } else {
          
            print("No location available.")
        }
        
        // Update GPS connection status and accuracy
        isGPSConnected = true
        gpsAccuracy = location.horizontalAccuracy
        
        if isRecording, let lastLocation = self.lastLocation {
            let delta = location.distance(from: lastLocation)
            
            // Calculate speed in meters per second
            let speedInMetersPerSecond = location.speed
            
            // Convert meters per second to miles per hour
            let speedInMPH = speedInMetersPerSecond * 2.23694
            
            // Check if the speed exceeds the threshold
            if speed >= speedThreshold { //Originally speedInMPH
                distance += delta * 0.00062137 // Convert meters to miles
                speed = speedInMPH
            }
            
            currentElevation = location.altitude // + relativeAltitude
        }
        
        // Update speed
        let speedInMetersPerSecond = location.speed
        speed = speedInMetersPerSecond * 2.23694 // Convert meters per second to miles per hour
        // topSpeed = speedInMetersPerSecond * 2.23694
        lastLocation = location
        if let waypoint = waypointLocation {
            let distanceToWaypoint = newLocation.distance(from: waypoint)
            debugPrint("GPS Distance to Waypointed Location: \(distanceToWaypoint) meters")
        }
        
        if let newLocation = locations.last {
            if let lastSpeed = lastSpeed {
                let timeInterval = newLocation.timestamp.timeIntervalSince(lastLocation?.timestamp ?? newLocation.timestamp)
                let speedChange = newLocation.speed - lastSpeed
                let acceleration = speedChange / timeInterval
                accelerationReadings.append(acceleration)
            }
            lastSpeed = newLocation.speed
            lastLocation = newLocation
        }
        lastSpeed = newLocation.speed
        lastLocation = newLocation
        
        // GPS connection error handling
        func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
            isGPSConnected = false
            gpsAccuracy = nil
            
            
            func checkElevationAndNotify(elevation: Double) {
                let moderateAltitude = 2500.0 // meters
                let highAltitude = 3500.0 // meters
                
                var message = ""
                
                if elevation > moderateAltitude && elevation <= highAltitude {
                    message = "You are at a moderate altitude. Oxygen levels may be lower than usual."
                } else if elevation > highAltitude {
                    message = "You are at a high altitude. Be cautious of lower oxygen levels and potential altitude sickness."
                }
                
                if !message.isEmpty {
                    sendNotificationWith(message: message)
                }
            }
            
        }
    }
    
    func updateElevation() {
        if let validLastLocation = lastLocation {
            let elevationInMeters = validLastLocation.altitude // + relativeAltitude
            self.currentElevation = elevationInMeters
            let elevationInFeet = elevationInMeters * 3.28084 // Convert meters to feet
            let elevationMetersFormatted = String(format: "%.2f", elevationInMeters)
            let elevationFeetFormatted = String(format: "%.2f", elevationInFeet)
            
            print("Elevation updated to: \(elevationMetersFormatted) meters / \(elevationFeetFormatted) feet")
        } else {
            print("No location available to update elevation.")
        }
    }
    
    func recordElevationReading(elevation: Double) {
        let newReading = ElevationReading(time: Date(), elevation: elevation)
        DispatchQueue.main.async {
            self.elevationReadings.append(newReading)
            print("New elevation recorded: \(newReading)")
            
        }
    }
    
    func updateLocationName(for location: CLLocation) {
        location.fetchCityAndState { [weak self] locationName in
            DispatchQueue.main.async {
                guard let self = self else { return }
                
                if let locationName = locationName {
                    // Geocoding succeeded, update current and last successful location names
                    self.lastSuccessfulLocationName = locationName
                    self.currentLocationName = locationName
                } else {
                    // Geocoding failed, use last successful location name if available
                    if !self.lastSuccessfulLocationName.isEmpty {
                        self.currentLocationName = self.lastSuccessfulLocationName
                    } else {
                        // No last successful location available
                        self.currentLocationName = ""
                    }
                }
            }
        }
    }
    
    func fetchCountyName(completion: @escaping (String?) -> Void) {
        let geocoder = CLGeocoder()

        if let location = self.latestLocation {
            geocoder.reverseGeocodeLocation(location) { placemarks, error in
                DispatchQueue.main.async {
                    if let error = error {
                        print("Error in reverse geocoding: \(error)")
                        completion(nil)
                    } else if let placemark = placemarks?.first, let county = placemark.subAdministrativeArea {
                        self.lastSuccessfulCountyName = county // Update the last successful county name
                        completion(county)
                    } else {
                        completion(nil)
                    }
                }
            }
        } else {
            completion(nil)
        }
    }
}


// MARK: - Helper Extensions
extension Array where Element == Double {
    func average() -> Double {
        return isEmpty ? 0 : reduce(0, +) / Double(count)
    }
}

/* extension CLLocation {
 func bearing(to destination: CLLocation) -> Double {
 let lat1 = self.coordinate.latitude.toRadians()
 let lon1 = self.coordinate.longitude.toRadians()
 
 let lat2 = destination.coordinate.latitude.toRadians()
 let lon2 = destination.coordinate.longitude.toRadians()
 
 let dLon = lon2 - lon1
 let y = sin(dLon) * cos(lat2)
 let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
 let rawBearing = atan2(y, x).toDegrees()
 
 // Normalize the bearing to be within 0° to 360°
 let normalizedBearing = (rawBearing < 0) ? (rawBearing + 360) : rawBearing
 debugPrint("Bearing to Destination: \(normalizedBearing)")
 return normalizedBearing
 }
 }
 
 extension Double {
 func toRadians() -> Double { self * .pi / 180 }
 func toDegrees() -> Double { self * 180 / .pi }
 }
 */


struct ElevationReading {
    var time: Date
    var elevation: Double
}

extension CLLocation {
    func fetchCityAndState(completion: @escaping (String?) -> Void) {
        CLGeocoder().reverseGeocodeLocation(self) { placemarks, error in
            if let error = error {
                print("Geocoding failed with error: \(error.localizedDescription)")
                completion(nil)
            } else if let placemark = placemarks?.first {
                let cityName = placemark.locality ?? ""
                let stateName = placemark.administrativeArea ?? ""
                let fullLocation = "\(cityName), \(stateName)"
                print("✓ Geocoding successful: \(fullLocation)")
                completion(fullLocation)
            } else {
                print("Geocoding failed: No placemarks found")
                completion(nil)
            }
        }
    }
}

/*extension LocationManager {
 
 func resetElevationData() {
 DispatchQueue.main.async {
 // Clear the elevation readings array
 self.elevationReadings.removeAll()
 
 // Reset current and previous elevation values
 self.currentElevation = 0.0
 self.previousElevation = nil
 
 // Other related properties can be reset here if they exist
 // For example:
 // self.totalElevationGain = 0.0
 }
 }
 } */
extension LocationManager {
    func extractState(from location: CLLocation, completion: @escaping (String?) -> Void) {
        let geocoder = CLGeocoder()
        geocoder.reverseGeocodeLocation(location) { placemarks, error in
            DispatchQueue.main.async {
                if let error = error {
                    print("Reverse geocoding failed: \(error.localizedDescription)")
                    completion(nil)
                } else if let placemark = placemarks?.first, let state = placemark.administrativeArea {
                    completion(state)
                } else {
                    completion(nil)
                }
            }
        }
    }
}
