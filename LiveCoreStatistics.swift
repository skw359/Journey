import SwiftUI

struct LiveCoreStatistics: View {
    @ObservedObject var locationManager: LocationManager
    @EnvironmentObject var userSettings: UserSettings

    var body: some View {
        VStack(spacing: -10) {
            Text(userSettings.isMetric ?
                 (userSettings.usePreciseUnits || locationManager.distance * 1.60934 < 16.09 ? "\(formatDisplayValue(locationManager.distance * 1.60934, usePreciseUnits: userSettings.usePreciseUnits)) " :
                    "\(Int(locationManager.distance * 1.60934)) ") :
                    (userSettings.usePreciseUnits || locationManager.distance < 10 ? "\(formatDisplayValue(locationManager.distance, usePreciseUnits: userSettings.usePreciseUnits)) " :
                        "\(Int(locationManager.distance)) "))
            .font(.system(size: 45))
            .fontWeight(.bold)
            .foregroundColor(userSettings.isDarkMode ? .black : .white) +
            Text(userSettings.isMetric ? " KM" : " MILES")
                .font(.headline)
                .fontWeight(.bold)
                .foregroundColor(Color(hex: "#05df73"))

            Text(userSettings.isMetric ?
                 (userSettings.usePreciseUnits ? "\(formatDisplayValue(max(locationManager.speed * 1.60934, 0), usePreciseUnits: true)) " :
                    (locationManager.speed * 1.60934 > 32.19 ? "\(String(format: "%.0f", max(locationManager.speed * 1.60934, 0))) " :
                        "\(formatDisplayValue(max(locationManager.speed * 1.60934, 0), usePreciseUnits: false)) ")) :
                    (userSettings.usePreciseUnits ? "\(formatDisplayValue(max(locationManager.speed, 0), usePreciseUnits: true)) " :
                        (locationManager.speed > 20 ? "\(String(format: "%.0f", max(locationManager.speed, 0))) " :
                            "\(formatDisplayValue(max(locationManager.speed, 0), usePreciseUnits: false)) ")))
            .font(.system(size: 45))
            .fontWeight(.bold)
            .foregroundColor(userSettings.isDarkMode ? .black : .white) +
            Text(userSettings.isMetric ? "KPH" : "MPH")
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
