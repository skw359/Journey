import SwiftUI

struct ElevationElement: View {
    @ObservedObject var locationManager: LocationManager
    @EnvironmentObject var userSettings: UserSettings
    
    private let feetPerMeter: Double = 3.28084
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(elevationText)
                .font(.system(size: 26))
                .foregroundColor(userSettings.isDarkMode ? .black : .white)
            Text("Elevation")
                .font(.system(size: 14))
                .foregroundColor(Color(hex: "#05df73"))
        }
    }
    
    private var elevationText: String {
        let elevationInFeet = locationManager.currentElevation * feetPerMeter
        return String(format: "%.0f ft", elevationInFeet)
    }
}
