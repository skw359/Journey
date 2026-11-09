// Root tab view of the app.

import SwiftUI

private enum AppTab: Hashable {
    case record
    case journeys
    case settings
    case search
}

struct ContentView: View {
    private enum RootScreen {
        case welcome
        case home
    }

    @Environment(PairingManager.self) private var pairingManager
    @Environment(LocationService.self) private var locationService
    @State private var selectedTab = AppTab.record
    @State private var currentRoot: RootScreen = ServerPairing.stored == nil ? .welcome : .home
    @State private var rootOpacity = 1.0
    @State private var rootTransitionTask: Task<Void, Never>?
    @State private var isLocked = false
    @State private var library = JourneyLibrary()
    @State private var searchText = ""
    @State private var journeyToReveal: Date?
    @State private var showUploads = false

    private let welcomeFadeDuration = 0.25
    private let homeFadeDuration = 0.5

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            rootContent
                .opacity(rootOpacity)
                .allowsHitTesting(rootOpacity > 0.01)

            LockOverlay(isLocked: $isLocked)
        }
        .onChange(of: pairingManager.isPaired) { _, isPaired in
            handlePairingChange(isPaired)
        }
        .onChange(of: pairingManager.serverURL) {
            library = JourneyLibrary()
            searchText = ""
        }
        .task(id: pairingManager.serverURL) {
            library.detailStore.resumeInterruptedUploads()
        }
        .onDisappear {
            rootTransitionTask?.cancel()
        }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var rootContent: some View {
        switch currentRoot {
        case .home:
            homeRoot
        case .welcome:
            WelcomeScreen()
        }
    }

    private var homeRoot: some View {
        TabView(selection: $selectedTab) {
            Tab("Record", systemImage: "record.circle.fill", value: AppTab.record) {
                HomeScreen(
                    isLocked: $isLocked,
                    isActive: selectedTab == .record,
                    onViewJourney: { startedAt in
                        journeyToReveal = startedAt
                        selectedTab = .journeys
                    },
                    onViewUploads: {
                        showUploads = true
                        selectedTab = .settings
                    }
                )
            }

            Tab("Journeys", systemImage: "point.bottomleft.forward.to.point.topright.scurvepath.fill", value: AppTab.journeys) {
                JourneysScreen(title: "Journeys", library: library, journeyToReveal: $journeyToReveal)
            }

            Tab("Settings", systemImage: "gearshape.fill", value: AppTab.settings) {
                SettingsScreen(showUploads: $showUploads)
            }

            Tab(value: AppTab.search, role: .search) {
                JourneysScreen(title: "Search", library: library, searchText: $searchText)
            }
        }
        .tint(AppConstants.journeyGreen)
        .tabViewSearchActivation(.searchTabSelection)
        .tabViewBottomAccessory(isEnabled: locationService.isRecording && selectedTab != .record) {
            RecordingAccessory {
                selectedTab = .record
            }
        }
    }

    private func handlePairingChange(_ isPaired: Bool) {
        rootTransitionTask?.cancel()

        if isPaired {
            guard currentRoot != .home else {
                rootOpacity = 1
                return
            }

            rootTransitionTask = Task { @MainActor in
                withAnimation(.easeOut(duration: welcomeFadeDuration)) {
                    rootOpacity = 0
                }

                try? await Task.sleep(nanoseconds: secondsToNanoseconds(welcomeFadeDuration))
                guard !Task.isCancelled else { return }

                selectedTab = .record
                currentRoot = .home
                rootOpacity = 0

                withAnimation(.easeInOut(duration: homeFadeDuration)) {
                    rootOpacity = 1
                }
            }
        } else {
            selectedTab = .record
            currentRoot = .welcome
            rootOpacity = 1
        }
    }

    private func secondsToNanoseconds(_ seconds: Double) -> UInt64 {
        UInt64(seconds * 1_000_000_000)
    }
}
