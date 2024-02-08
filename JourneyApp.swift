import SwiftUI

@main
struct Journey_Watch_AppApp: App {
    var userSettings = UserSettings()
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(userSettings)
        }
    }
}
