import SwiftUI
import WatchKit

struct OptionsScreen: View {
    @Binding var isLocked: Bool
    @Binding var isPaused: Bool
    @Binding var showWaypointScreen: Bool
    @Binding var isCreatingWaypoint: Bool
    @Binding var selectedTab: Int
    @ObservedObject var locationManager: LocationManager
    @Binding var navigationPath: NavigationPath
    var prepareTravelData: () -> TravelData
    var elapsedTime: Int
    
    let waypointTab = -2
    let stopRecordingViewTab = 3

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.edgesIgnoringSafeArea(.all)

                VStack(spacing: geometry.size.height * 0.05) {
                    HStack(spacing: geometry.size.width * 0.05) {
                        waterLockButton(size: geometry.size)
                        waypointButton(size: geometry.size)
                    }
                    HStack(spacing: geometry.size.width * 0.05) {
                        endButton(size: geometry.size)
                        pauseButton(size: geometry.size)
                    }
                }
            }
        }
    }

    private func waterLockButton(size: CGSize) -> some View {
        Button(action: {
            isLocked.toggle()
            if isLocked {
                WKInterfaceDevice.current().enableWaterLock()
                selectedTab = stopRecordingViewTab
            }
        }) {
            VStack(spacing: 2) {
                ZStack {
                    Image(systemName: "drop.degreesign.fill")
                        .font(.system(size: size.width * 0.15))
                        .foregroundColor(isLocked ? Color(hex: "#44d7b6") : Color(hex: "#44d7b6"))
                }
                .frame(width: size.width * 0.40, height: size.width * 0.40)
                .background(Color(hex: "#292929"))
                .clipShape(Circle())
                
                Text("Lock")
                    .font(.system(size: size.width * 0.07))
                    .foregroundColor(.white)
            }
        }
        .buttonStyle(PlainButtonStyle())
    }

    private func waypointButton(size: CGSize) -> some View {
        Button(action: {
            locationManager.startWaypointCalculation()
            locationManager.averagedWaypointLocation = nil
            isCreatingWaypoint = true
            showWaypointScreen = true
            
            locationManager.averageWaypointLocation { averagedLocation in
                if let averagedLocation = averagedLocation {
                    locationManager.averagedWaypointLocation = averagedLocation
                }
                isCreatingWaypoint = false
                showWaypointScreen = false
                playHapticSuccessFeedback()
                selectedTab = waypointTab
            }
        }) {
            VStack(spacing: 2) {
                Image(systemName: "mappin.and.ellipse")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size.width * 0.22, height: size.width * 0.22)
                    .foregroundColor(Color(hex: "#34d34b"))
                    .frame(width: size.width * 0.40, height: size.width * 0.40)
                    .background(Color(hex: "#292929"))
                    .clipShape(Circle())
                Text("Waypoint")
                    .font(.system(size: size.width * 0.07))
                    .foregroundColor(.white)
            }
        }
        .buttonStyle(PlainButtonStyle())
    }

    private func endButton(size: CGSize) -> some View {
        Button(action: {
            withAnimation {
                navigationPath.append(NavigationItem.travelRecorded(prepareTravelData()))
                locationManager.stopRecording()
                playHapticFeedbackEnd()
            }
        }) {
            VStack(spacing: 2) {
                Image(systemName: "xmark")
                    .font(.system(size: size.width * 0.15))
                    .foregroundColor(Color(hex: "#FF2727"))
                
                Text("End")
                    .font(.system(size: size.width * 0.07))
                    .foregroundColor(.white)
            }
            .frame(width: size.width * 0.40, height: size.width * 0.40)
            .background(Color(hex: "#220100"))
            .cornerRadius(15)
        }
        .buttonStyle(PlainButtonStyle())
    }

    private func pauseButton(size: CGSize) -> some View {
            Button(action: {
                locationManager.togglePause()
            }) {
                VStack(spacing: 2) {
                    Image(systemName: locationManager.isPaused ? "play.fill" : "pause.fill")
                        .font(.system(size: size.width * 0.15))
                        .foregroundColor(locationManager.isPaused ? Color(hex: "#ffd700") : Color(hex: "#ffd700"))
                    Text(locationManager.isPaused ? "Resume" : "Pause")
                        .font(.system(size: size.width * 0.07))
                        .foregroundColor(.white)
                }
                .frame(width: size.width * 0.40, height: size.width * 0.40)
                .background(Color(hex: "#2b2917"))
                .cornerRadius(15)
            }
            .buttonStyle(PlainButtonStyle())
        }
    
    private func playHapticSuccessFeedback() {
        WKInterfaceDevice.current().play(.success)
    }
    
    private func playHapticFeedbackEnd() {
        WKInterfaceDevice.current().play(.stop)
    }
}
