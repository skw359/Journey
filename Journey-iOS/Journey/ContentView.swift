import SwiftUI

struct ContentView: View {
    private enum RootScreen {
        case welcome
        case home
    }

    @Environment(PairingManager.self) private var pairingManager
    @State private var selectedTab = 0
    @State private var currentRoot: RootScreen = ServerPairing.stored == nil ? .welcome : .home
    @State private var rootOpacity = 1.0
    @State private var rootTransitionTask: Task<Void, Never>?
    @State private var isLocked = false

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

    @ViewBuilder
    private var homeRoot: some View {
        VStack(spacing: 0) {
            Group {
                switch selectedTab {
                case 0:
                    HomeScreen(isLocked: $isLocked)
                case 1:
                    JourneysScreen()
                default:
                    SettingsScreen()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            CustomTabBar(selectedTab: $selectedTab)
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

                selectedTab = 0
                currentRoot = .home
                rootOpacity = 0

                withAnimation(.easeInOut(duration: homeFadeDuration)) {
                    rootOpacity = 1
                }
            }
        } else {
            selectedTab = 0
            currentRoot = .welcome
            rootOpacity = 1
        }
    }

    private func secondsToNanoseconds(_ seconds: Double) -> UInt64 {
        UInt64(seconds * 1_000_000_000)
    }
}
