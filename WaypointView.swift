import SwiftUI
import CoreLocation

struct WaypointView: View {
    @ObservedObject var locationManager: LocationManager
    @State private var showInstructions = true
    @State private var pulsate = false
    @State private var showCircle = false
    @State private var backgroundColor = Color.black
    @State private var textColor = Color.white
    @State private var circleColor = Color(hex: "#00ff81")
    @State private var ringColor = Color.gray
    @State private var distanceInFeet: Double = 0
    
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
                VStack {
                    if let _ = locationManager.latestLocation,
                       let _ = locationManager.averagedWaypointLocation {
                        Text(distanceInFeet >= 5280 ?
                             "\(distanceInFeet / 5280 == floor(distanceInFeet / 5280) ? String(format: "%.0f", distanceInFeet / 5280) : String(format: "%.1f", distanceInFeet / 5280)) miles" :
                                "\(Int(distanceInFeet)) feet")
                        .font(.system(size: 45))
                        .bold()
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity, alignment: .center)
                        
                        ZStack {
                            Image(systemName: "arrow.up")
                                .foregroundColor(circleColor)
                                .font(Font.system(size: 60))
                                .bold()
                                .rotationEffect(.degrees(bearingToWaypoint))
                                .scaleEffect(showCircle ? 0 : 1)
                                .opacity(showCircle ? 0 : 1)
                            
                            if showCircle {
                                PulsatingCircle(circleColor: circleColor, ringColor: ringColor)
                                    .frame(width: 30, height: 30)
                                    .scaleEffect(showCircle ? 1 : 0)
                            }
                        }
                        .frame(width: geometry.size.width, height: geometry.size.height / 2, alignment: .center)
                        
                    } else {
                        Spacer()
                        Text("No waypoint defined. Please create one.")
                            .foregroundColor(Color(hex: "#00ff81"))
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    }
                    Spacer()
                }
            }
            .onChange(of: locationManager.latestLocation) { _ in
                updateDistance()
            }
            .onChange(of: distanceInFeet) { newValue in
                withAnimation {
                    updateColors(for: newValue)
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
        if distance < 10 {
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
}

struct PulsatingCircle: View {
    @State private var pulsate = false
    var circleColor: Color
    var ringColor: Color
    
    var body: some View {
        ZStack {
            Circle()
                .stroke(ringColor, lineWidth: 2)
                .scaleEffect(pulsate ? 1.2 : 1.0)
                .opacity(pulsate ? 0.0 : 1.0)
                .animation(Animation.easeInOut(duration: 1).repeatForever(autoreverses: false), value: pulsate)
            
            Circle()
                .fill(circleColor)
        }
        .onAppear {
            self.pulsate.toggle()
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
