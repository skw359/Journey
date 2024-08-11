import SwiftUI
import CoreLocation

struct RecordingView: View {
    @ObservedObject var locationManager: LocationManager
    @EnvironmentObject var userSettings: UserSettings
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                
                // SignalStrengthElement (top left)
                signalStrengthElement
                    .position(x: geometry.size.width * 0.12, y: geometry.size.height * 0.19)
                
                RecordingIndicator()
                    .position(x: WKInterfaceDevice.current().screenBounds.width == 198.0 ?
                              (geometry.size.width * 0.12 + 29 + 50) :
                                geometry.size.width / 2,
                              y: geometry.size.height * 0.064)
                
                // LiveCoreStatistics (centered horizontally and vertically)
                LiveCoreStatistics(locationManager: locationManager)
                    .environmentObject(userSettings)
                    .position(x: geometry.size.width / 2, y: geometry.size.height / 2.2)
                
                // CityNameElement (1/4 down the screen vertically, centered horizontally)
                CityNameElement(locationManager: locationManager)
                    .position(x: geometry.size.width / 2, y: geometry.size.height * 0.2)
                
                // ElevationElement (bottom left)
                ElevationElement(locationManager: locationManager)
                    .frame(width: geometry.size.width * 0.4)
                    .position(x: geometry.size.width * 0.20, y: geometry.size.height * 0.8)
                
                // TotalTimeElement (bottom right)
                TotalTimeElement(locationManager: locationManager)
                    .frame(width: geometry.size.width * 0.4)
                    .position(x: geometry.size.width * 0.75, y: geometry.size.height * 0.8)
                pauseOverlay(size: geometry.size)
                    .opacity(locationManager.paused ? 1 : 0)
                    .animation(.easeInOut(duration: 0.35), value: locationManager.paused)
                    .allowsHitTesting(locationManager.paused)
            }
            
        }
        .edgesIgnoringSafeArea(.all)
    }
    
    private func pauseOverlay(size: CGSize) -> some View {
        ZStack {
            Color.black.opacity(0.95)
            
            VStack(spacing: 20) {
                Image(systemName: "pause.circle.fill")
                    .font(.system(size: size.width * 0.2))
                    .foregroundColor(.white)
                
                Text("Journey Paused")
                    .font(.system(size: size.width * 0.08, weight: .bold))
                    .foregroundColor(.white)
            }
        }
        .frame(width: size.width, height: size.height)
        .position(x: size.width / 2, y: size.height / 2)
      /*  .onTapGesture {
            withAnimation(.easeInOut(duration: 0.25)) {
                locationManager.togglePause()
            }
        }
       */
    }
    
    private var signalStrengthElement: some View {
        Group {
            if let accuracy = locationManager.gpsAccuracy {
                SignalStrengthElement(accuracy: accuracy)
                    .frame(width: 50, height: 20)
            }
        }
    }
}
