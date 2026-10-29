import SwiftUI

struct LiveCoreStatistics: View {
    @ObservedObject var recorder: JourneyRecorder
    @EnvironmentObject var userSettings: UserSettings

    var body: some View {
        VStack(spacing: -10) {
            Text("\(formatDisplayValue(recorder.distance, usePreciseUnits: userSettings.usePreciseUnits)) ")
                .font(.system(size: 45))
                .fontWeight(.bold)
                .foregroundColor(userSettings.isDarkMode ? .black : .white) +
            Text(" MILES")
                .font(.headline)
                .fontWeight(.bold)
                .foregroundColor(Color(hex: "#05df73"))

            Text(userSettings.usePreciseUnits ? "\(formatDisplayValue(max(recorder.speed, 0), usePreciseUnits: true)) " :
                    (recorder.speed > 20 ? "\(String(format: "%.0f", max(recorder.speed, 0))) " :
                        "\(formatDisplayValue(max(recorder.speed, 0), usePreciseUnits: false)) "))
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
