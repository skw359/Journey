import SwiftUI
import CoreLocation

struct WaypointScreen: View {
    @ObservedObject var locationManager: LocationManager
    @State private var showInstructions = true
    @State private var pulsate = false
    @State private var showCircle = false
    @State private var backgroundColor = Color.black
    @State private var textColor = Color.white
    @State private var circleColor = Color(hex: "#00ff81")
    @State private var ringColor = Color.gray
    @State private var distanceInFeet: Double = 0
    @StateObject private var userSettings = UserSettings()
    @State private var showWaytracerInfo = false
    @State private var isWaypointButtonDisabled = false
    @State private var elapsedTime = 0
    @State private var isCreatingWaypoint = false
    
    var waypointExists: Bool {
        locationManager.averagedWaypointLocation != nil
    }
    
    var bearingToWaypoint: Double {
        guard let currentLocation = locationManager.lastLocation,
              let waypointLocation = locationManager.averagedWaypointLocation else { return 0 }
        
        let bearingFromNorth = currentLocation.bearing(to: waypointLocation)
        let userHeading = locationManager.userHeading
        
        let relativeBearing = bearingFromNorth - userHeading
        let finalBearing = relativeBearing >= 0 ? relativeBearing : 360 + relativeBearing
        
        print("Current Location: \(currentLocation), Waypoint Location: \(waypointLocation), User Heading: \(userHeading), Bearing to Waypoint: \(finalBearing)") // debug message
        return finalBearing
    }
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                backgroundColor
                    .edgesIgnoringSafeArea(.all)
                
                VStack(spacing: 0) {
                    VStack {
                        if locationManager.latestLocation != nil, locationManager.averagedWaypointLocation != nil {
                            Text(userSettings.isMetric ?
                                 (distanceInFeet * 0.3048 < 100 ? String(format: "%.0f meters", distanceInFeet * 0.3048) :
                                    (distanceInFeet * 0.3048 < 10000 ? String(format: "%.1f km", distanceInFeet * 0.3048 / 1000) :
                                        String(format: "%.0f km", distanceInFeet * 0.3048 / 1000))) :
                                    (distanceInFeet < 528 ? String(format: "%.0f feet", distanceInFeet) :
                                        (distanceInFeet < 52800 ? String(format: "%.1f miles", distanceInFeet / 5280) :
                                            String(format: "%.0f miles", distanceInFeet / 5280))))
                            .font(.system(size: 45))
                            .bold()
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity, alignment: .center)
                            
                            ZStack {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 60))
                                    .bold()
                                    .foregroundColor(circleColor)
                                    .rotationEffect(.degrees(bearingToWaypoint))
                                    .opacity(distanceInFeet > 20 ? 1 : 0)
                                    .scaleEffect(distanceInFeet > 10 ? 1 : 0.1)
                                    .animation(.easeInOut(duration: 0.5), value: distanceInFeet)
                                    .offset(y:-10)
                                
                                if distanceInFeet <= 20 {
                                    Circle()
                                        .fill(Color.gray.opacity(0.5))
                                        .scaleEffect(distanceInFeet / 20)
                                        .frame(width: 100, height: 100)
                                        .offset(y: 16)
                                        .animation(.easeInOut(duration: 0.5), value: distanceInFeet)
                                    
                                    Image(systemName: "mappin")
                                        .font(.system(size: 60))
                                        .foregroundColor(.white)
                                        .offset(y: -10)
                                        .opacity(distanceInFeet <= 20 ? 1 : 0)
                                        .scaleEffect(distanceInFeet <= 20 ? 1 : 0.1)
                                        .animation(.easeInOut(duration: 0.5), value: distanceInFeet)
                                }
                            }
                            .frame(width: geometry.size.width, height: geometry.size.height / 2, alignment: .center)
                            
                        } else {
                            Spacer()
                            GeometryReader { geometry in
                                VStack {
                                    Spacer()
                                    
                                    HStack {
                                        Image(systemName: "location.circle.fill")
                                            .foregroundColor(Color(hex: "#00ff81"))
                                            .font(.headline)
                                        AnimatedGradientText(text: "Waytracer")
                                    }
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .offset(y: geometry.size.height / 396 * 20 - 15)
                                    
                                    Button(action: { showWaytracerInfo.toggle() }) {
                                        HStack(alignment: .center, spacing: 10) {
                                            Image(systemName: "questionmark.circle")
                                                .resizable()
                                                .aspectRatio(contentMode: .fit)
                                                .frame(width: 20, height: 20)
                                                .foregroundColor(.white)
                                            
                                            Text("What's this?")
                                                .foregroundColor(.white)
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding()
                                        .background(Color(hex: "#222223"))
                                        .cornerRadius(15)
                                    }
                                    .buttonStyle(PlainButtonStyle())
                                    
                                    Spacer()
                                }
                                .sheet(isPresented: $showWaytracerInfo) {
                                    ScrollView {
                                        VStack(alignment: .leading, spacing: 16) {
                                            Text("Worried about finding your way back?")
                                                .font(.headline)
                                                .bold()
                                            
                                            Text("Waytracer allows you to mark any location and then effortlessly find that spot later through detailed navigation.")
                                            Text("For example, you can retrace your steps to a viewpoint you discovered, or mark your vehicle's location before going on a backcountry trek.")
                                            
                                            Button(action: {
                                                createWaypoint()
                                            }) {
                                                HStack {
                                                    Image(systemName: "mappin.and.ellipse")
                                                        .resizable()
                                                        .aspectRatio(contentMode: .fit)
                                                        .frame(width: 20, height: 20)
                                                        .foregroundColor(.white)
                                                    
                                                    if isWaypointButtonDisabled {
                                                        ShimmeringText(text: "Creating...", baseColor: .white)
                                                    } else {
                                                        Text("Create Waypoint")
                                                            .foregroundColor(.white)
                                                    }
                                                }
                                                .frame(maxWidth: .infinity)
                                                .padding()
                                                .background(isWaypointButtonDisabled ? Color(hex: "#222223") : Color(hex: "#222223"))
                                                .cornerRadius(15)
                                            }
                                            .buttonStyle(PlainButtonStyle())
                                            .disabled(isWaypointButtonDisabled)
                                        }
                                    }
                                }
                            }
                        }
                        Spacer()
                    }
                }
                .onChange(of: locationManager.latestLocation) { _, newValue in
                    updateDistance()
                }
                .onChange(of: distanceInFeet) { _, newValue in
                    withAnimation {
                        updateColors(for: newValue)
                    }
                }
            }
        }
    }
    
    private func updateDistance() {
        guard let currentLocation = locationManager.latestLocation,
              let waypointLocation = locationManager.averagedWaypointLocation else { return }
        
        let distanceInMeters = currentLocation.distance(from: waypointLocation)
        distanceInFeet = distanceInMeters * 3.28084
    }
    
    private func updateColors(for distance: Double) {
        if distance < 20 {
            backgroundColor = .green
            textColor = .white
            circleColor = .white
            ringColor = Color(hex: "#8de4b6")
        } else {
            backgroundColor = .black
            textColor = .black
            circleColor = Color(hex: "#00ff81")
            ringColor = .gray
        }
    }
    
    private func playHapticSuccessFeedback() {
        let device = WKInterfaceDevice.current()
        device.play(.success)
    }
    
    private func createWaypoint() {
        isWaypointButtonDisabled = true
        locationManager.startWaypointCalculation()
        locationManager.averagedWaypointLocation = nil
        elapsedTime = 0
        isCreatingWaypoint = true
        
        locationManager.averageWaypointLocation { averagedLocation in
            if let averagedLocation = averagedLocation {
                locationManager.averagedWaypointLocation = averagedLocation
            }
            isCreatingWaypoint = false
            isWaypointButtonDisabled = false
            playHapticSuccessFeedback()
        }
    }
}

extension CLLocation {
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

extension View {
    @ViewBuilder
    func `if`<Content: View>(_ condition: Bool, transform: (Self) -> Content) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}
