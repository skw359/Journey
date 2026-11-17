// App entry point.

import SwiftUI

@main
struct JourneyApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var pairingManager = PairingManager()
    @State private var locationService = LocationService()
    @State private var uploadManager: UploadManager
    private let connectivityManager: PhoneConnectivityManager

    init() {
        KeychainHelper.upgradeAccessibility(key: AppConstants.keychainTokenKey)
        let uploadManager = UploadManager()
        _uploadManager = State(initialValue: uploadManager)
        connectivityManager = PhoneConnectivityManager(uploadManager: uploadManager)

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
                .onAppear {
                    VideoUploadQueue.shared.removeOrphans()
                    // Nothing is recording yet at launch, so any CSV left is an interrupted trip.
                    uploadManager.recoverLeftoverRecordings(active: locationService.activeRecordingFile)
                    uploadManager.startRetryingWhenOnline()
                    Task {
                        await pairingManager.checkServerReachability()
                        await uploadManager.retryPending()
                    }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .background:
                        locationService.appDidEnterBackground()
                    case .active:
                        locationService.appDidBecomeActive()
                        UploadBackgroundTime.shared.appDidBecomeActive()
                        VideoUploadQueue.shared.appDidBecomeActive()
                        Task { await uploadManager.retryPending() }
                    default:
                        break
                    }
                }
        }
    }
}
