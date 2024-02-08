import SwiftUI
import CoreLocation

struct WaypointView: View {
    @ObservedObject var locationManager: LocationManager
    @State private var showInstructions = true
    @State private var pulsate = false
    @State private var showCircle = false
    
    var bearingToWaypoint: Double {
        guard let currentLocation = locationManager.lastLocation,
              let waypointLocation = locationManager.averagedWaypointLocation else { return 0 }
        
        let bearingFromNorth = currentLocation.bearing(to: waypointLocation)
        let userHeading = locationManager.userHeading
        
        // Calculate the relative bearing
        let relativeBearing = bearingFromNorth - userHeading
        let finalBearing = relativeBearing >= 0 ? relativeBearing : 360 + relativeBearing
        //return relativeBearing >= 0 ? relativeBearing : 360 + relativeBearing
        
        print("Current Location: \(currentLocation), Waypoint Location: \(waypointLocation), User Heading: \(userHeading), Bearing to Waypoint: \(finalBearing)")
        return finalBearing
    }
    
    var body: some View {
            GeometryReader { geometry in
                VStack {
                    if let currentLocation = locationManager.latestLocation,
                       let waypointLocation = locationManager.averagedWaypointLocation {
                        let distanceInMeters = currentLocation.distance(from: waypointLocation)
                        let distanceInFeet = distanceInMeters * 3.28084
                        
                        Text(distanceInFeet >= 528 ? String(format: "%.1f miles", distanceInFeet / 5280) : String(format: "%.0f feet", distanceInFeet))
                            .font(.system(size: 20))
                            .bold()
                            .frame(maxWidth: .infinity, alignment: .center)
                        
                        ZStack {
                            Image(systemName: "arrow.up")
                                .foregroundColor(Color(hex: "#00ff81"))
                                .font(Font.system(size: 46))
                                .rotationEffect(.degrees(bearingToWaypoint))
                                .scaleEffect(showCircle ? 0 : 1)
                                .opacity(showCircle ? 0 : 1)
                            
                            if showCircle {
                                PulsatingCircle()
                                    .frame(width: 30, height: 30)
                                    .scaleEffect(showCircle ? 1 : 0)
                            }
                        }
                        .frame(width: geometry.size.width, height: geometry.size.height / 2, alignment: .center)
                        .onChange(of: distanceInFeet) { newValue in
                            withAnimation(.easeInOut(duration: 0.5)) {
                                showCircle = newValue < 10
                            }
                        }
                    } else {
                        Spacer()
                        Text("No waypoint defined. Please create one.")
                            .foregroundColor(Color(hex: "#00ff81"))
                    }
                }
                Spacer()
            }
        }
}

struct PulsatingCircle: View {
    @State private var pulsate = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.gray, lineWidth: 2)
                .scaleEffect(pulsate ? 1.2 : 1.0)
                .opacity(pulsate ? 0.0 : 1.0)
                .animation(Animation.easeInOut(duration: 1).repeatForever(autoreverses: false), value: pulsate)
            
            Circle()
                .fill(Color.green)
        }
        .onAppear {
            self.pulsate.toggle()
        }
    }
}

struct InstructionsScreen: View {
    var dismissAction: () -> Void
    
    var body: some View {
        VStack {
            Text("Waypoint Directions")
                .font(.system(size: 20))
                .bold()
                .frame(maxWidth: .infinity, alignment: .center)
            
            Text("Follow these directions to reach your waypoint:")
                .padding(.top, 20)
            
            
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


