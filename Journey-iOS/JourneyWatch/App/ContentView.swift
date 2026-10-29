import SwiftUI
import CoreLocation
import WatchKit

// Stores travel-related information like distance, speed, and time
struct TravelData: Hashable {
    var milesTraveled: Double
    var topSpeed: Double
    var averageSpeed: Double
    var totalTime: Int
    var elapsedTime: String
}

// Defines navigation items for the app
enum NavigationItem: Hashable {
    case travelRecorded(TravelData)
}

// Managing overall app state and navigation
struct ContentView: View {
    @State private var showSettings = false
    @StateObject private var recorder = JourneyRecorder()
    @State private var selectedTab = 1
    @State private var isLocked = false
    @State private var paused = false
    @State private var navigationPath = NavigationPath()
    @State private var showWaypointScreen = false
    @State private var creatingWaypoint = false
    @State private var elapsedTime = 0
    @EnvironmentObject var userSettings: UserSettings
    @State private var obtainedGPS = false
    @State private var showWelcomeScreen: Bool = UserDefaults.standard.bool(forKey: "showWelcomeScreen") == false

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if showWelcomeScreen {
                    WelcomeScreen(showWelcomeScreen: $showWelcomeScreen)
                } else if recorder.isRecording {
                    RecordingTabs(selectedTab: $selectedTab,
                                  recorder: recorder,
                                  isLocked: $isLocked,
                                  paused: $paused,
                                  showWaypointScreen: $showWaypointScreen,
                                  creatingWaypoint: $creatingWaypoint,
                                  navigationPath: $navigationPath,
                                  prepareTravelData: prepareTravelData,
                                  elapsedTime: elapsedTime)
                } else {
                    StartScreen(showSettings: $showSettings,
                                obtainedGPS: $obtainedGPS,
                                recorder: recorder,
                                startRecording: startRecording)
                }
            }
            .navigationDestination(for: NavigationItem.self) { item in
                switch item {
                case .travelRecorded(let travelData):
                    TravelRecordedView(travelData: travelData, navigationPath: $navigationPath, recorder: recorder)
                }
            }
            .background(userSettings.isDarkMode ? Color.white.opacity(1.0) : Color.black.opacity(1.0))
            .fullScreenCover(isPresented: $showWaypointScreen) {
                WaypointCreationView(creatingWaypoint: $creatingWaypoint)
            }
        }
        .onChange(of: recorder.obtainedGPS) {
            obtainedGPS = recorder.obtainedGPS
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(userSettings)
        }
        .onAppear {
            recorder.requestPermissions()
            WatchConnectivityManager.shared.pingPhone()
        }
    }

    private func startRecording() {
        withAnimation {
            recorder.elevationReadings.removeAll()
            Haptics.vibrate(.start)
            elapsedTime = 0
            recorder.startRecording()
            selectedTab = 1
            creatingWaypoint = false
            recorder.moderateAltitudeNotificationSent = false
            recorder.highAltitudeNotificationSent = false
        }
    }

    func prepareTravelData() -> TravelData {
        return TravelData(
            milesTraveled: recorder.distance,
            topSpeed: recorder.topSpeed,
            averageSpeed: recorder.averageSpeed,
            totalTime: elapsedTime,
            elapsedTime: recorder.totalTimeTextTimer
        )
    }
}

// Manages the tab view displayed during recording
struct RecordingTabs: View {
    @Binding var selectedTab: Int
    @ObservedObject var recorder: JourneyRecorder
    @Binding var isLocked: Bool
    @Binding var paused: Bool
    @Binding var showWaypointScreen: Bool
    @Binding var creatingWaypoint: Bool
    @Binding var navigationPath: NavigationPath
    let prepareTravelData: () -> TravelData
    let elapsedTime: Int

    var body: some View {
        TabView(selection: $selectedTab) {
            NowPlayingView()
                .tabItem { Text("Now Playing") }
                .tag(-3)

            SpeedGoalScreen(recorder: recorder)
                .tabItem { Text("Target Speed") }
                .tag(-2)

            WaypointScreen(recorder: recorder)
                .tabItem { Text("Waypoint") }
                .tag(-1)

            CompassScreen(viewModel: recorder)
                .tabItem { Text("Compass") }
                .tag(0)

            RecordingView(recorder: recorder)
                .tabItem { Text("Recording") }
                .tag(1)

            OptionsScreen(isLocked: $isLocked, showWaypointScreen: $showWaypointScreen, creatingWaypoint: $creatingWaypoint, selectedTab: $selectedTab, recorder: recorder, navigationPath: $navigationPath, prepareTravelData: prepareTravelData, elapsedTime: elapsedTime)
                .tabItem { Text("Stop Recording") }
                .tag(3)
        }
        .animation(.easeInOut(duration: 0.3), value: selectedTab)
        .tabViewStyle(PageTabViewStyle(indexDisplayMode: .never))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .edgesIgnoringSafeArea(.all)
    }
}

// Shows a simple view when creating a new waypoint
struct WaypointCreationView: View {
    @Binding var creatingWaypoint: Bool

    var body: some View {
        VStack {
            Spacer()
            Shine(
                iconName: "mappin.and.ellipse",
                text: "Creating waypoint",
                baseColor: Color(hex: "#545454")
            )
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.edgesIgnoringSafeArea(.all))
    }
}

extension Color {
    init(hex: String) {
        let scanner = Scanner(string: hex)
        _ = scanner.scanString("#")

        var rgbValue: UInt64 = 0
        scanner.scanHexInt64(&rgbValue)

        let red = Double((rgbValue >> 16) & 0xFF) / 255.0
        let green = Double((rgbValue >> 8) & 0xFF) / 255.0
        let blue = Double(rgbValue & 0xFF) / 255.0

        self.init(red: red, green: green, blue: blue)
    }
}
