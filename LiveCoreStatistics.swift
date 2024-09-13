import SwiftUI

struct LiveCoreStatistics: View {
    @ObservedObject var locationManager: LocationManager
    @EnvironmentObject var userSettings: UserSettings

    var body: some View {
        VStack(spacing: -10) {
            Text("\(formatDisplayValue(locationManager.distance, usePreciseUnits: userSettings.usePreciseUnits)) ")
                .font(.system(size: 45))
                .fontWeight(.bold)
                .foregroundColor(userSettings.isDarkMode ? .black : .white) +
            Text(" MILES")
                .font(.headline)
                .fontWeight(.bold)
                .foregroundColor(Color(hex: "#05df73"))

            Text(userSettings.usePreciseUnits ? "\(formatDisplayValue(max(locationManager.speed, 0), usePreciseUnits: true)) " :
                    (locationManager.speed > 20 ? "\(String(format: "%.0f", max(locationManager.speed, 0))) " :
                        "\(formatDisplayValue(max(locationManager.speed, 0), usePreciseUnits: false)) "))
            .font(.system(size: 45))
            .fontWeight(.bold)
            .foregroundColor(userSettings.isDarkMode ? .black : .white) +
            Text("MPH")
                .font(.headline)
                .foregroundColor(Color(hex: "#05df73"))
        }
    }

    private func formatDisplayValue(_ value: Double, usePreciseUnits: Bool) -> String {
        let threshold = usePreciseUnits ? 0.01 : 0.1

        if value < threshold {
            return "0"
        } else {
            let format = usePreciseUnits ? "%.2f" : "%.1f"
            return String(format: format, value)
        }
    }
}
