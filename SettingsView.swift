// This file serves as the settings menu
import SwiftUI

/*                Text("Switch between metric (km/h, meters) and imperial (mph, feet) units.")
 .font(.caption)
 .foregroundColor(.gray)
 .padding(.leading, 0) // Adjust padding as needed
 */

struct SettingsView: View {
    @EnvironmentObject var userSettings: UserSettings
    //  @ObservedObject var userSettings = UserSettings.shared
    
    var body: some View {
        VStack {
            Text("Settings")
                .font(.headline)
                .bold()
                .padding(-37) //-30 should be fine
            Form {
                Section(header: Text("General")) {
                    Toggle("Use Metric Units", isOn: $userSettings.isMetric)
                    
                    
                    Toggle("Use Precise Units", isOn: $userSettings.usePreciseUnits)
                    Text("Display values with two decimal places to the best of the GPS signal.")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                Section(header: Text("User Interface")) {
                    Toggle("Light Mode", isOn: $userSettings.isDarkMode)
                    
                }
            }
        }
    }
}
