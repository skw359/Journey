import SwiftUI
import UserNotifications

@main
struct JourneyWatchApp_Watch_AppApp: App {
    @StateObject private var userSettings = UserSettings()

    init() {
        _ = WatchConnectivityManager.shared
        _ = WatchFeedbackManager.shared

        let notificationOptions: UNAuthorizationOptions = [.alert, .sound, .badge]
        UNUserNotificationCenter.current().requestAuthorization(options: notificationOptions) { granted, error in
            if granted {
                print("Notification authorization granted")
            } else if let error = error {
                print("Notification authorization error: \(error.localizedDescription)")
            }
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(userSettings)
        }
    }
}
