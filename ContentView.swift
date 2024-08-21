// Summary: ContentView manages the overall app state, switching between welcome, start, and recording screens.
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

// Defines navigation items for the app, currently only handling recorded travel data
enum NavigationItem: Hashable {
    case travelRecorded(TravelData)
}

// Managing overall app state and navigation. Handles recording state, GPS signal, and user interactions. Displays different screens based on app state (welcome, start, or recording)
struct ContentView: View {
    @State private var showSettings = false
    @StateObject private var locationManager = LocationManager()
    @State private var selectedTab = 1
    @State private var isLocked = false
    @State private var paused = false
    @State private var navigationPath = NavigationPath()
    @State private var showWaypointScreen = false
    @State private var creatingWaypoint = false
    @State private var elapsedTime = 0
    @StateObject private var userSettings = UserSettings()
    @State private var obtainedGPS = false
    @State private var showWelcomeScreen: Bool = UserDefaults.standard.bool(forKey: "showWelcomeScreen") == false
    
    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if showWelcomeScreen {
                    WelcomeScreen(showWelcomeScreen: $showWelcomeScreen)
                } else if locationManager.recording {
                    RecordingTabs(selectedTab: $selectedTab,
                                  locationManager: locationManager,
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
                                locationManager: locationManager,
                                startRecording: startRecording)
                }
            }
            .navigationDestination(for: NavigationItem.self) { item in
                switch item {
                case .travelRecorded(let travelData):
                    TravelRecordedView(travelData: travelData, navigationPath: $navigationPath, locationManager: locationManager)
                }
            }
            .background(userSettings.isDarkMode ? Color.white.opacity(1.0) : Color.black.opacity(1.0))
            .fullScreenCover(isPresented: $showWaypointScreen) {
                WaypointCreationView(creatingWaypoint: $creatingWaypoint)
            }
        }
        .onChange(of: locationManager.obtainedGPS) {
            obtainedGPS = locationManager.obtainedGPS
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(userSettings)
        }
        
    }
    
    // Initiates the recording process, resets relevant data, and updates the UI
    private func startRecording() {
        withAnimation {
            locationManager.elevationReadings.removeAll()
            Haptics.vibrate(.start)
            elapsedTime = 0
            locationManager.startRecording()
            selectedTab = 1 // recordingViewTab
            creatingWaypoint = false
            locationManager.moderateAltitudeNotificationSent = false
            locationManager.highAltitudeNotificationSent = false
        }
    }
    
    // Gathers current travel data from the location manager for display or storage
    func prepareTravelData() -> TravelData {
        return TravelData(
            milesTraveled: locationManager.distance,
            topSpeed: locationManager.topSpeed,
            averageSpeed: locationManager.averageSpeed,
            totalTime: elapsedTime,
            elapsedTime: locationManager.totalTimeTextTimer
        )
    }
}

// Manages the tab view displayed during recording. Includes tabs for various features like Now Playing, Waypoint, Speed Target, etc.
struct RecordingTabs: View {
    @Binding var selectedTab: Int
    @ObservedObject var locationManager: LocationManager
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
            
            WaypointScreen(locationManager: locationManager)
                .tabItem { Text("Waypoint")}
                .tag(-2)
            
            SpeedGoalScreen(locationManager: locationManager)
                .tabItem { Text("Target Speed") }
                .tag(-1)
            
            CompassScreen(viewModel: locationManager)
                .tabItem { Text("Waypoint")}
                .tag(0)
            
            RecordingView(locationManager: locationManager)
                .tabItem { Text("Recording") }
                .tag(1)
            
            OptionsScreen(isLocked: $isLocked, showWaypointScreen: $showWaypointScreen, creatingWaypoint: $creatingWaypoint, selectedTab: $selectedTab, locationManager: locationManager, navigationPath: $navigationPath, prepareTravelData: prepareTravelData, elapsedTime: elapsedTime)
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
