import SwiftUI
import CoreLocation


struct WaypointView: View {
    @ObservedObject var locationManager: LocationManager
    @State private var distanceText = ""
    @State private var backgroundColor = Color.black
    @State private var circleColor = Color(hex: "#00ff81")
    @State private var ringColor = Color.gray

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                backgroundColor
                    .edgesIgnoringSafeArea(.all)
                
                VStack {
                    if let latestLocation = locationManager.latestLocation,
                       let waypointLocation = locationManager.averagedWaypointLocation {
                        Text(distanceText)
                            .font(.system(size: 45))
                            .bold()
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity, alignment: .center)
                        
                        Text("Your Caption Here")
                            .font(.caption)
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity)
                            .offset(y: 120)
                        
                        ArrowView(bearingToWaypoint: calculateBearing(latestLocation: latestLocation, waypointLocation: waypointLocation))
                            .opacity(locationManager.distanceInFeet > 20 ? 1 : 0)
                            .animation(.easeInOut(duration: 0.5))
                            .offset(y: -10)
                        
                        if locationManager.distanceInFeet <= 20 {
                            Circle()
                                .fill(Color.gray.opacity(0.5))
                                .scaleEffect(locationManager.distanceInFeet / 20)
                                .frame(width: 100, height: 100)
                                .offset(y: 16)
                                .animation(.easeInOut(duration: 0.5))
                            
                            Image(systemName: "mappin")
                                .font(.system(size: 60))
                                .foregroundColor(.white)
                                .offset(y: -10)
                                .opacity(locationManager.distanceInFeet <= 20 ? 1 : 0)
                                .scaleEffect(locationManager.distanceInFeet <= 20 ? 1 : 0.1)
                                .animation(.easeInOut(duration: 0.5))
                        }
                    } else {
                        Spacer()
                        VStack {
                            Text("Waypoint Direction")
                                .font(.system(size: 20))
                                .bold()
                                .frame(maxWidth: .infinity, alignment: .center)
                                .offset(y: 5)
                            
                            Text("No waypoint defined. Please create one.")
                                .foregroundColor(Color(hex: "#00ff81"))
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                        }
                    }
                    Spacer()
                }
            }
        }
        .onReceive(locationManager.$distanceInFeet) { distance in
            updateColors(for: distance)
        }
    }
    
    private func updateColors(for distance: Double) {
        if distance < 20 {
            backgroundColor = .green
            circleColor = .white
            ringColor = Color(hex: "#8de4b6")
        } else {
            backgroundColor = .black
            circleColor = Color(hex: "#00ff81")
            ringColor = .gray
        }
        updateDistanceText(distance)
    }
    
    private func updateDistanceText(_ distance: Double) {
        if distance < 528 {
            distanceText = String(format: "%.0f feet", distance)
        } else if distance < 52800 {
            distanceText = String(format: "%.1f miles", distance / 5280)
        } else {
            distanceText = String(format: "%.0f miles", distance / 5280)
        }
    }
    
    private func calculateBearing(latestLocation: CLLocation, waypointLocation: CLLocation) -> Double {
        let bearingFromNorth = latestLocation.bearing(to: waypointLocation)
        let userHeading = locationManager.userHeading
        
        let relativeBearing = bearingFromNorth - userHeading
        let finalBearing = relativeBearing >= 0 ? relativeBearing : 360 + relativeBearing
        return finalBearing
    }
}

struct ArrowView: View {
    var bearingToWaypoint: Double
    
    var body: some View {
        Image(systemName: "arrow.up")
            .font(.system(size: 60))
            .bold()
            .foregroundColor(.white)
            .rotationEffect(.degrees(bearingToWaypoint))
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
