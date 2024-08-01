import SwiftUI
import CoreLocation

struct WaypointScreen: View {
    @ObservedObject var locationManager: LocationManager
    @StateObject private var userSettings = UserSettings()
    
    @State private var backgroundColor = Color.black
    @State private var textColor = Color.white
    @State private var circleColor = Color(hex: "#00ff81")
    @State private var ringColor = Color.gray
    @State private var distanceInFeet: Double = 0
    @State private var showWaytracerInfo = false
    @State private var isWaypointButtonDisabled = false
    @State private var isCreatingWaypoint = false
    
    var waypointExists: Bool {
        locationManager.averagedWaypointLocation != nil
    }
    
    var bearingToWaypoint: Double {
        locationManager.bearingToWaypoint
    }
    
    var distanceText: String {
        DistanceFormatter.shared.formatDistance(distanceInFeet,
                                                isMetric: userSettings.isMetric)
    }
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                backgroundColor
                    .edgesIgnoringSafeArea(.all)
                
                VStack(spacing: 0) {
                    VStack {
                        if locationManager.latestLocation != nil, locationManager.averagedWaypointLocation != nil {
                            Text(distanceText)
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
                .onChange(of: locationManager.latestLocation) { _, _ in
                    updateWaypointInfo()
                }
            }
        }
    }
    
    private func updateWaypointInfo() {
        guard let currentLocation = locationManager.latestLocation,
              let waypointLocation = locationManager.averagedWaypointLocation else { return }
        
        // Update distance
        let distanceInMeters = currentLocation.distance(from: waypointLocation)
        distanceInFeet = distanceInMeters * 3.28084
        
        // Update colors
        withAnimation {
            if distanceInFeet < 20 {
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
    
    private func createWaypoint() {
        isWaypointButtonDisabled = true
        locationManager.startWaypointCalculation()
        locationManager.averagedWaypointLocation = nil
        
        isCreatingWaypoint = true
        
        locationManager.averageWaypointLocation { averagedLocation in
            if let averagedLocation = averagedLocation {
                locationManager.averagedWaypointLocation = averagedLocation
            }
            isCreatingWaypoint = false
            isWaypointButtonDisabled = false
            Haptics.vibrate(.success)
        }
    }
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
