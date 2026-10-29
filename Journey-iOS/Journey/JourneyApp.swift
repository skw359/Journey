import SwiftUI
import WatchConnectivity

@main
struct JourneyApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var pairingManager = PairingManager()
    @State private var locationService = LocationService()
    @State private var uploadManager = UploadManager()
    @State private var connectivityManager = PhoneConnectivityManager()

    init() {
        if let navFont = UIFont(name: "Montserrat-Regular", size: 17),
           let navLargeFont = UIFont(name: "Montserrat-Bold", size: 34) {
            UINavigationBar.appearance().titleTextAttributes = [.font: navFont]
            UINavigationBar.appearance().largeTitleTextAttributes = [.font: navLargeFont]
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .font(.custom("Montserrat-Regular", size: 17, relativeTo: .body))
                .environment(pairingManager)
                .environment(locationService)
                .environment(uploadManager)
                .environment(connectivityManager)
                .onAppear {
                    connectivityManager.configure(uploadManager: uploadManager)
                    Task { await pairingManager.checkServerReachability() }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .background:
                        locationService.appDidEnterBackground()
                    case .active:
                        locationService.appDidBecomeActive()
                    default:
                        break
                    }
                }
        }
    }
}
