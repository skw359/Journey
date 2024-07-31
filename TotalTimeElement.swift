import SwiftUI

struct TotalTimeElement: View {
    @ObservedObject var locationManager: LocationManager
    @EnvironmentObject var userSettings: UserSettings
    
    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Text(locationManager.totalTimeTextTimer)
                .font(.system(size: 26))
                .foregroundColor(userSettings.isDarkMode ? .black : .white)
            Text("Total Time")
                .font(.system(size: 14))
                .foregroundColor(Color(hex: "#05df73"))
        }
    }
}
