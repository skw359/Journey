import SwiftUI

struct ElevationView: View {
    @ObservedObject var locationManager: LocationManager
    @EnvironmentObject var userSettings: UserSettings
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(userSettings.isMetric ?
                 "\(locationManager.currentElevation, specifier: "%.0f") m" :
                    "\(locationManager.currentElevation * 3.28084, specifier: "%.0f") ft")
                .font(.system(size: 26))
                .foregroundColor(userSettings.isDarkMode ? .black : .white)
            Text("Elevation")
                .font(.system(size: 14))
                .foregroundColor(Color(hex: "#05df73"))
        }
    }
}
