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
                              (geometry.size.width * 0.12 + 29 + 50) : // Adjusting for 45mm screen
                              geometry.size.width / 2,
                              y: geometry.size.height * 0.064)
                
                // LiveCoreStatistics (centered horizontally and vertically)
                LiveCoreStatistics(locationManager: locationManager)
                    .environmentObject(userSettings)
                    .position(x: geometry.size.width / 2, y: geometry.size.height / 2.2)
                
                // CityNameElement (1/4 down the screen vertically, centered horizontally)
                CityNameElement(locationManager: locationManager)
                    .position(x: geometry.size.width / 2, y: geometry.size.height * 0.2)
                
                // ElevationView (bottom left)
                ElevationView(locationManager: locationManager)
                    .frame(width: geometry.size.width * 0.4)
                    .position(x: geometry.size.width * 0.20, y: geometry.size.height * 0.8)
                
                // TotalTimeElement (bottom right)
                TotalTimeElement(locationManager: locationManager)
                    .frame(width: geometry.size.width * 0.4)
                    .position(x: geometry.size.width * 0.80, y: geometry.size.height * 0.8)
            }
            
        }
        .edgesIgnoringSafeArea(.all)
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
