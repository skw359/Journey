// This file serves as the settings menu
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var userSettings: UserSettings
    
    var body: some View {
        VStack {
            Text("Settings")
                .font(.headline)
                .bold()
                .padding(-37)
            Form {
                Section(header: Text("General")) {
                    Toggle("Use Precise Units", isOn: $userSettings.usePreciseUnits)
                    Text("Display values with two decimal places.")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            }
        }
    }
}
