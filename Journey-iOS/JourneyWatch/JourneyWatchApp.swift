// Entry point for the watch app.

import SwiftUI

@main
struct JourneyWatchApp: App {
    init() {
        PhoneLink.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
