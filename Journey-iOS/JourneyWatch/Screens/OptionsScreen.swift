import SwiftUI
import WatchKit

struct OptionsScreen: View {
    @Binding var isLocked: Bool
    @Binding var showWaypointScreen: Bool
    @Binding var creatingWaypoint: Bool
    @Binding var selectedTab: Int
    @ObservedObject var recorder: JourneyRecorder
    @Binding var navigationPath: NavigationPath
    var prepareTravelData: () -> TravelData
    var elapsedTime: Int

    @State private var displayProcessingSheet = false

    let waypointTab = -1
    let stopRecordingViewTab = 3

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.edgesIgnoringSafeArea(.all)

                VStack(spacing: geometry.size.height * 0.05) {
                    HStack(spacing: geometry.size.width * 0.05) {
                        waterLockButton(size: geometry.size)
                            .disabled(recorder.paused)
                            .opacity(recorder.paused ? 0.2 : 1)
                            .animation(.easeInOut(duration: 0.15), value: recorder.paused)
                        waypointButton(size: geometry.size)
                            .disabled(recorder.paused)
                            .opacity(recorder.paused ? 0.2 : 1)
                            .animation(.easeInOut(duration: 0.15), value: recorder.paused)
                    }
                    HStack(spacing: geometry.size.width * 0.05) {
                        endButton(size: geometry.size)
                        pauseButton(size: geometry.size)
                    }
                }
            }
        }
        .sheet(isPresented: $displayProcessingSheet) {
            ProcessingSheet()
                .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func waterLockButton(size: CGSize) -> some View {
        Button(action: {
            isLocked.toggle()
            if isLocked {
                WKInterfaceDevice.current().enableWaterLock()
                withAnimation(.easeInOut(duration: 0.3)) {
                    selectedTab = 1
                }
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
            recorder.startWaypointCalculation()
            recorder.averagedWaypointLocation = nil
            creatingWaypoint = true
            showWaypointScreen = true

            recorder.averageWaypointLocation { averagedLocation in
                if let averagedLocation = averagedLocation {
                    recorder.averagedWaypointLocation = averagedLocation
                }
                creatingWaypoint = false
                showWaypointScreen = false
                Haptics.vibrate(.success)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        selectedTab = waypointTab
                    }
                }
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
            displayProcessingSheet = true

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                DispatchQueue.global(qos: .userInitiated).async {
                    let travelData = prepareTravelData()
                    DispatchQueue.main.async {
                        withAnimation {
                            navigationPath.append(NavigationItem.travelRecorded(travelData))
                            recorder.stopRecording()
                            displayProcessingSheet = false
                            Haptics.vibrate(.stop)
                        }
                    }
                }
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
            withAnimation(.easeInOut(duration: 0.15)) {
                recorder.togglePause()
            }
        }) {
            VStack(spacing: 2) {
                Image(systemName: recorder.paused ? "play.fill" : "pause.fill")
                    .font(.system(size: size.width * 0.15))
                    .foregroundColor(recorder.paused ? Color(hex: "#46ff40") : Color(hex: "#ffd700"))
                Text(recorder.paused ? "Resume" : "Pause")
                    .font(.system(size: size.width * 0.07))
                    .foregroundColor(.white)
            }
            .frame(width: size.width * 0.40, height: size.width * 0.40)
            .background(recorder.paused ? Color(hex: "#0f360d") : Color(hex: "#2b2917"))
            .cornerRadius(15)
        }
        .buttonStyle(PlainButtonStyle())
    }
}
