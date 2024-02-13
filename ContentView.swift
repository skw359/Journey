import SwiftUI // Framework for building user interfaces in a declarative way. It allows you to create user interfaces across Apple devices.
import CoreLocation // Framework that providess GPS coordinates, monitoring location changes, and geofencing.
import Combine // Framework introduced by Apple for handling asynchronous and event-driven code using a declarative Swift API. It's used for working with asynchronous data streams and reactive programming.
import WatchKit // Provides components and APIs tailored for Apple Watch app development.
import CoreMotion // Altimeter stuff
import WatchConnectivity
import UserNotifications //for later use

// Define TravelData as a standalone struct outside ContentView
struct TravelData: Hashable {
    var milesTraveled: Double
    var topSpeed: Double
    var averageSpeed: Double
    var totalTime: Int
    var elapsedTime: String
}

// Define NavigationItem enum outside ContentView
enum NavigationItem: Hashable {
    case travelRecorded(TravelData)
}

struct ContentView: View {
    
    @State private var showSettings = false
    @StateObject private var locationManager = LocationManager()
    @State private var milesOffset = CGFloat(100)
    @State private var milesOpacity = 0.0
    @State private var timeOffset = CGFloat(100)
    @State private var timeOpacity = 0.0
    @State private var selectedTab = 1
    @State private var isLocked = false
    @State private var shouldNavigate = false
    @State var isMetric = false
    @State private var isPaused = false
    @State private var isRecording = false
    @State private var navigateToRecordedView = false
    @State private var navigationPath = NavigationPath()
    @State private var showRecordingView = true
    @State private var waypointLocation: CLLocation?
    @State private var isCreatingWaypoint = false
    @State private var isWaypointCreated = false
    @State private var showExitButton = false
    @State private var exitButtonOpacity = 0.0
    @State private var messageIndex = 0
    @State private var elapsedTime = 0
    @State private var showSpecialMessage = false
    @State private var hasPlayedHaptic = false
    @State private var showMenu = false
    @State private var timer: Timer?
    @StateObject private var userSettings = UserSettings()
    @State private var isSignalFull = false
    @State private var showCounty = false
    @State private var countyName: String = ""
    
    private let messages = ["Creating Waypoint..."]
    private let specialMessage = "Please ensure clear sky view."
    
    let animationDuration = 0.4
    @State private var hasShownWelcomeScreen: Bool = UserDefaults.standard.bool(forKey: "hasShownWelcomeScreen")
    
    private func startElevationRefresh() {
        setupTimer()
    }
    
    private func setupTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            self.elapsedTime += 1
            print("Elapsed Time: \(self.elapsedTime)")
        }
    }
    
    private func refreshElevation() {
        locationManager.updateElevation()
    }
    
    // Checks if a welcome screen has been shown before and displays different content based on that condition. If the welcome screen has been shown, it further checks if a location manager is currently recording. If it is, it displays a TabView with two tabs (recordingView and stopRecordingView). If recording is not in progress, it displays the recordingView (aka "Record Travel" screen). If the welcome screen hasn't been shown, it displays a WelcomeView.
    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if hasShownWelcomeScreen {
                    
                    if locationManager.isRecording {
                        TabView(selection: $selectedTab) {
                            NowPlayingView()
                                .tabItem { Text("Now Playing") }
                                .tag(-2)

                            WaypointView(locationManager: locationManager)
                                .tabItem { Text("Waypoint")}
                                .tag(-1)
                            
                            CompassView(viewModel: locationManager)
                                .tabItem { Text("Waypoint")}
                                .tag(0)
                            
                            recordingView // Main recording view
                                .tabItem { Text("Recording") }
                                .tag(1)
                            
                            stopRecordingView // Swipe left from recording view
                                .tabItem { Text("Stop Recording") }
                                .tag(2)
                        }
                        .tabViewStyle(PageTabViewStyle(indexDisplayMode: .never))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .edgesIgnoringSafeArea(.all)
                    } else {
                        // Display the Record button when not recording
                        recordingView
                    }
                } else {
                    WelcomeView(hasShownWelcomeScreen: $hasShownWelcomeScreen)
                }
            }
            .navigationDestination(for: NavigationItem.self) { item in
                switch item {
                case .travelRecorded(let travelData):
                    TravelRecordedView(travelData: travelData, navigationPath: $navigationPath, locationManager: locationManager)
                }
            }
            
            .onChange(of: isCreatingWaypoint) {
                if !isCreatingWaypoint {
                    selectedTab = -1
                    playHapticFeedback()
                }
            }
            .background(userSettings.isDarkMode ? Color.white.opacity(1.0) : Color.black.opacity(1.0))
            
        }
    }
    
    private func playHapticFeedback() {
        let device = WKInterfaceDevice.current()
        device.play(.success)
    }
    
    func prepareTravelData() -> TravelData {
        return TravelData(
            milesTraveled: locationManager.distance,
            topSpeed: locationManager.topSpeed,
            averageSpeed: locationManager.averageSpeed,
            totalTime: elapsedTime,  // If totalTime is still relevant
            elapsedTime: locationManager.totalTimeTextTimer // Directly assigning the string
        )
    }
    
    // Shows the welcome screen. Only displays on first launch.
    struct WelcomeView: View {
        @Binding var hasShownWelcomeScreen: Bool
        var body: some View {
            
            VStack(spacing: 20) {
                Text("Welcome to Journey.")
                    .font(.system(size: 17))
                    .fontWeight(.bold)
                    .multilineTextAlignment(.center)
                
                Text("Journey helps you track your traveled distance and current speed. Not meant for indoor use.")
                    .font(.system(size: 11))
                    .multilineTextAlignment(.center)
                
                Button(action: {
                    // Add the action you want to perform when the button is pressed
                    hasShownWelcomeScreen = true
                    UserDefaults.standard.set(true, forKey: "hasShownWelcomeScreen")
                    
                }) {
                    Text("Continue")
                        .fontWeight(.bold)
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.white)
                        .cornerRadius(10)
                }
                .buttonStyle(PlainButtonStyle()) 
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(hex: "#0c3617").edgesIgnoringSafeArea(.all))
        }
    }
    
    func formatDisplayValue(_ value: Double, usePreciseUnits: Bool) -> String {
        let threshold = usePreciseUnits ? 0.01 : 0.1
        
        if value < threshold {
            return "0"
        } else {
            let format = usePreciseUnits ? "%.2f" : "%.1f"
            return String(format: format, value)
        }
    }
    
    var recordingView: some View {
        ZStack {
            VStack {
                if locationManager.isRecording {
                    HStack {
                        if let accuracy = locationManager.gpsAccuracy {
                            SignalStrengthView(accuracy: accuracy)
                            
                                .frame(width: 50, height: 20)
                            
                            
                        } else {
                        }
                        Spacer()
                    }
                    .padding(.leading, 10)
                    .padding(.top, 5)
                    
                    VStack(spacing: -10) {
                        
                        Text(userSettings.isMetric ?
                             (userSettings.usePreciseUnits || locationManager.speed * 1.60934 <= 32.19 ? "\(formatDisplayValue(locationManager.distance * 1.60934, usePreciseUnits: userSettings.usePreciseUnits)) " :
                                (locationManager.distance * 1.60934 > 16.09 ? String(format: "%.0f", locationManager.distance * 1.60934) : "\(formatDisplayValue(locationManager.distance * 1.60934, usePreciseUnits: userSettings.usePreciseUnits)) ")) :
                                (userSettings.usePreciseUnits || locationManager.speed <= 20 ? "\(formatDisplayValue(locationManager.distance, usePreciseUnits: userSettings.usePreciseUnits)) " :
                                    (locationManager.distance > 10 ? String(format: "%.0f", locationManager.distance) : "\(formatDisplayValue(locationManager.distance, usePreciseUnits: userSettings.usePreciseUnits)) ")))
                        .font(.system(size: 45))
                        .fontWeight(.bold)
                        .foregroundColor(userSettings.isDarkMode ? .black : .white) +
                        Text(userSettings.isMetric ? "KM" : "MILES")
                            .font(.headline)
                            .fontWeight(.bold)
                            .foregroundColor(Color(UIColor(hex: "#05df73")))
                        
                        Text(userSettings.isMetric ?
                             (userSettings.usePreciseUnits ? "\(formatDisplayValue(max(locationManager.speed * 1.60934, 0), usePreciseUnits: true)) " :
                                (locationManager.speed * 1.60934 > 32.19 ? String(format: "%.0f", max(locationManager.speed * 1.60934, 0)) :
                                    "\(formatDisplayValue(max(locationManager.speed * 1.60934, 0), usePreciseUnits: false)) ")) :
                                (userSettings.usePreciseUnits ? "\(formatDisplayValue(max(locationManager.speed, 0), usePreciseUnits: true)) " :
                                    (locationManager.speed > 20 ? String(format: "%.0f", max(locationManager.speed, 0)) :
                                        "\(formatDisplayValue(max(locationManager.speed, 0), usePreciseUnits: false)) ")))
                        .font(.system(size: 45))
                        .fontWeight(.bold)
                        .foregroundColor(userSettings.isDarkMode ? .black : .white) +
                        Text(userSettings.isMetric ? "KPH" : "MPH")
                            .font(.headline)
                            .foregroundColor(Color(UIColor(hex: "#05df73")))
                    }
                    
                    
                    .offset(y: -15)
                    .onTapGesture {
                    }
                    // .padding()
                    .onAppear {
                        withAnimation(.easeOut(duration: 0.3)) {
                            self.milesOffset = 0
                            self.milesOpacity = 1.0
                        }
                    }
                    
                    HStack {
                        Spacer()
                        VStack(alignment: .trailing) {
                            Text(locationManager.totalTimeTextTimer)
                                .font(.system(size: 26))
                            
                                .foregroundColor(userSettings.isDarkMode ? .black : .white) // Conditional color
                                .offset(y: -5)
                            Text("Total Time")
                                .font(.system(size: 14))
                                .foregroundColor(Color(UIColor(hex: "#05df73"))) // Light green
                                .frame(width: 68, alignment: .trailing)
                                .offset(y: -5)
                                .offset(x: -5)
                        }
                        .offset(x: -5)
                    }
                    
                    .offset(y: timeOffset)
                    .opacity(timeOpacity)
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            withAnimation(.easeOut(duration: 0.0)) {
                                self.timeOffset = 0
                                self.timeOpacity = 1.0
                            }
                        }
                    }
                } else {
                    // Display the "Record Travel" button
                    Button(action: {
                        withAnimation {
                            
                            // locationManager.resetElevationData()
                            // locationManager.currentElevation = 0.0
                            // locationManager.previousElevation = nil
                            locationManager.elevationReadings.removeAll()
                            playHapticFeedbackStart()
                            elapsedTime = 0
                            locationManager.startRecording()
                            selectedTab = 1
                            isCreatingWaypoint = false
                            // locationManager.startAltimeterUpdates()
                            self.isRecording.toggle()
                        }
                    }) {
                        HStack(alignment: .center, spacing: 10) {
                            Image(systemName: "record.circle")
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: 30, height: 30)
                                .foregroundColor(Color(hex: "#00ff81"))
                            
                            Text("Record Travel")
                                .fontWeight(.bold)
                                .foregroundColor(.white)
                        }
                        
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color(hex: "#0c3617"))
                        .cornerRadius(15)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .overlay(
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
                                Image(systemName: "exclamationmark.circle")
                                    .font(.system(size: 14, weight: .bold))
                                    .foregroundColor(.red)
                                
                                Text("Not meant for indoor use")
                                    .font(.system(size: 12))
                                    .foregroundColor(Color.white)
                                    .padding()
                                Spacer()
                                
                            }
                            
                            .background(Color(hex: "#3b0d07"))
                            .cornerRadius(100)
                            .frame(width:200)
                            .offset(y: 80)
                            Spacer()
                            
                        }
                    )
                }
            }
            .overlay(
                VStack {
                    Spacer()
                    HStack {
                        if locationManager.isRecording {
                            VStack(alignment: .leading) {
                                Text(userSettings.isMetric ?
                                     "\(locationManager.currentElevation, specifier: "%.0f") m" :
                                        "\(locationManager.currentElevation * 3.28084, specifier: "%.0f") ft")
                                .font(.system(size: 26))
                                
                                .foregroundColor(userSettings.isDarkMode ? .black : .white)
                                Text("Elevation")
                                    .font(.system(size: 14))
                                
                                    .foregroundColor(Color(UIColor(hex: "#05df73")))
                            }
                            .padding([.leading, .bottom], 20)
                            .offset(y: -16)
                            .offset(x: -10)
                            Spacer()
                        }
                    }
                    
                    .onTapGesture {
                        isMetric.toggle()
                    }
                }
                    .edgesIgnoringSafeArea(.bottom),
                alignment: .bottomLeading
            )
            // Displays current city, state
            if locationManager.isRecording {
                Text(showCounty ? countyName : locationManager.currentLocationName)
                    .onTapGesture {
                        locationManager.fetchCountyName { county in
                            if let unwrappedCounty = county {
                                self.countyName = unwrappedCounty
                                self.showCounty.toggle()
                            } else {
                                // Use last known county name as a fallback
                                self.countyName = locationManager.lastSuccessfulCountyName
                                self.showCounty.toggle()
                            }
                        }
                    }
                    .padding(8)
                    .background(Color.black.opacity(0.0))
                    .cornerRadius(10)
                    .foregroundColor(Color(hex: "#bee0ec"))
                    .padding(.bottom, 155)
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 0.2), value: locationManager.isRecording)
            }
        }
        .overlay(
            Group {
                if !locationManager.isRecording {
                    HStack {
                        Button(action: {
                            showSettings = true
                        }) {
                            Image(systemName: "gear")
                                .font(.title)
                                .foregroundColor(.white)
                                .offset(x: -50, y: -70)
                        }
                        .background(Color.clear)
                        .offset(x: -20, y: -20)
                        .buttonStyle(PlainButtonStyle())
                        .zIndex(1)
                        // Displays the SettingsView when showSettings is true
                        .sheet(isPresented: $showSettings) {
                            SettingsView()
                                .environmentObject(userSettings)
                        }
                    }
                }
            }
        )
        
    }
    
    private func playHapticFeedbackEnd() {
        let device = WKInterfaceDevice.current()
        device.play(.stop)
    }
    
    func playHapticFeedbackStart() {
        let device = WKInterfaceDevice.current()
        device.play(.start)
    }
    
    // Code to display the water lock button and its respective actions
    struct WaterLockButtonView: View {
        @Binding var isLocked: Bool
        
        var body: some View {
            Button(action: {
                isLocked.toggle()
                if isLocked {
                    WKInterfaceDevice.current().enableWaterLock()
                    
                }
            }) {
                ZStack {
                    Image(systemName: "drop.degreesign.fill")
                        .font(.title2)
                        .foregroundColor(Color(hex: "#44d7b6"))
                }
                .frame(width: 80, height: 80)
                .background(Color(hex: "#292929"))
                .cornerRadius(10)
                .overlay(
                    Text("Lock")
                        .font(.caption)
                        .foregroundColor(.white),
                    alignment: .bottom
                )
            }
            .padding(.top, 40)
            .padding(.leading, 20)
            .buttonStyle(PlainButtonStyle())
        }
    }
    
    var stopRecordingView: some View {
        VStack {
            HStack {
                Button(action: {
                    isLocked.toggle()
                    if isLocked {
                        WKInterfaceDevice.current().enableWaterLock()
                        selectedTab = 1
                    }
                }) {
                    VStack {
                        ZStack {
                            Image(systemName: "drop.degreesign.fill")
                                .font(.title2)
                                .foregroundColor(isLocked ? Color(hex: "#44d7b6") : Color(hex: "#44d7b6"))
                        }
                        .frame(width: 80, height: 80)
                        .background(Color(hex: "#292929"))
                        .cornerRadius(100)
                        
                        Text("Lock")
                            .font(.caption)
                            .foregroundColor(.white)
                    }
                }
                .padding(.top, 40)
                .padding(.leading, 20)
                .offset(x: -3)
                .buttonStyle(PlainButtonStyle())
                Spacer()
                
                VStack {
                    Button(action: {
                        locationManager.startWaypointCalculation()
                        //clear locationmanager's waypointed location
                        locationManager.averagedWaypointLocation = nil
                        messageIndex = 0
                        elapsedTime = 0
                        showSpecialMessage = false
                        isCreatingWaypoint = true
                        
                        locationManager.averageWaypointLocation { averagedLocation in
                            // Step 3: Handle the completion with the new location
                            if let averagedLocation = averagedLocation {
                                locationManager.averagedWaypointLocation = averagedLocation
                            }
                            isCreatingWaypoint = false
                        }
                    }) {
                        VStack {  // Use a VStack to stack the icon and background together
                            Image(systemName: "plus")
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: 30, height: 30)
                                .foregroundColor(Color(hex: "#34d34b"))
                            
                                .frame(width: 80, height: 80)
                                .background(Color(hex: "#292929"))
                                .cornerRadius(100)
                            Text("Waypoint")
                                .font(.caption)
                                .foregroundColor(.white)
                        }
                    }
                    
                    .buttonStyle(PlainButtonStyle())
                    
                }
                .padding(.top, 40)
                .offset(x: -19)
                .offset(y: 0)
                
            }
            
            Spacer()
            
            // Bottom Left - End Button
            HStack {
                Button(action: {
                    withAnimation {
                        navigateToRecordedView = true
                        navigationPath.append(NavigationItem.travelRecorded(prepareTravelData()))
                        locationManager.stopAltimeterUpdates()
                        locationManager.stopRecording()
                        playHapticFeedbackEnd()
                        
                    }
                }) {
                    VStack {
                        Image(systemName: "xmark")
                            .font(.title2)
                            .foregroundColor(Color(hex: "#FF2727"))
                            .padding(.bottom, 2)
                        
                        Text("End")
                            .font(.caption)
                            .foregroundColor(.white)
                    }
                    .frame(width: 80, height: 80)
                    .background(Color(hex: "#220100"))
                    .cornerRadius(10)
                }
                .padding([.bottom, .leading], 20)
                .buttonStyle(PlainButtonStyle())
                
                Spacer()
                
                // Bottom Right - Pause Button
                Button(action: {
                    isPaused.toggle() // Toggle le pause
                }) {
                    VStack {
                        Image(systemName: isPaused ? "play.fill" : "pause.fill")
                            .font(.title2)
                            .foregroundColor(isPaused ? Color(hex: "#ffd700") : Color(hex: "#ffd700"))
                            .padding(.bottom, 2)
                        Text(isPaused ? "Resume" : "Pause")
                            .font(.caption)
                            .foregroundColor(.white)
                    }
                    .frame(width: 80, height: 80)
                    .background(Color(hex: "#2b2917"))
                    .cornerRadius(10)
                }
                .padding([.bottom, .trailing], 20)
                .buttonStyle(PlainButtonStyle())
            }
        }
        
        .overlay(
            ZStack {
                if isCreatingWaypoint {
                    HStack {
                        Spacer()
                        Button(action: {
                            isCreatingWaypoint = false
                        }) {
                            ZStack {
                                Circle() // This creates the circular background
                                    .fill(Color.black.opacity(0.0))
                                    .frame(width: 44, height: 44)
                                
                                Image(systemName: "xmark.circle.fill")
                                    .font(.title)
                                    .foregroundColor(.white)
                            }
                        }
                        .opacity(showExitButton ? 1 : 0)
                    }
                    
                    Image("image")
                        .resizable()
                        .scaledToFill()
                        .imageScale(.large)
                        .opacity(isCreatingWaypoint ? 1 : 0)
                        .animation(.easeInOut(duration: 2.0), value: isCreatingWaypoint)
                    
                    
                    VStack {
                        LoadingView()
                            .offset(x: -85)
                            .offset(y: showSpecialMessage ? 10 : 0)
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        
                        Text(showSpecialMessage ? specialMessage : messages[messageIndex])
                            .offset(y: -25)
                            .offset(x: 15)
                            .font(.headline)
                            .foregroundColor(showSpecialMessage ? .green : .white)
                    }
                    // Place the exit button in the top left corner
                    if showExitButton {
                        HStack {
                            Button(action: {
                                isCreatingWaypoint = false
                                messageIndex = 0
                                elapsedTime = 0
                                showSpecialMessage = false
                            }) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.title)
                                    .foregroundColor(.white)
                            }
                            .background(Color.black.opacity(0.5))
                            
                            .padding()
                            Spacer()
                            
                        }
                        .padding(.top, -120)
                        Spacer()
                        
                    }
                }
            }
                .buttonStyle(PlainButtonStyle())
            
                .onAppear {
                    print("Overlay appeared, isCreatingWaypoint: \(isCreatingWaypoint)")
                    
                    _ = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                        elapsedTime += 1
                        
                        if elapsedTime == 30 {
                            // Play haptic feedback only once
                            
                            showSpecialMessage = true
                            showExitButton = true
                        } else if elapsedTime % 10 == 0 && elapsedTime < 30 {
                            // Update message index every 10 seconds, but only before 30 seconds
                            withAnimation(.easeInOut) {
                                exitButtonOpacity = 1.0
                                messageIndex = (messageIndex + 1) % messages.count
                            }
                        }
                    }
                }
                .onChange(of: isCreatingWaypoint) {
                    print("isCreatingWaypoint changed to: \($isCreatingWaypoint)")
                }
                .background(Color.black.edgesIgnoringSafeArea(.all))
            
        )
    }
}

// Extensions to utilize hex colors
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

extension UIColor {
    convenience init(hex: String) {
        let hexString = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        let scanner = Scanner(string: hexString)
        
        if hexString.hasPrefix("#") {
            scanner.currentIndex = hexString.index(after: hexString.startIndex)
        }
        
        var color: UInt64 = 0
        scanner.scanHexInt64(&color)
        
        let mask = 0x000000FF
        let r = CGFloat(Int(color >> 16) & mask) / 255
        let g = CGFloat(Int(color >> 8) & mask) / 255
        let b = CGFloat(Int(color) & mask) / 255
        
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}

struct SignalStrengthView: View {
    var accuracy: CLLocationAccuracy?
    @State private var showSignalBars = true
    @State private var signalStrengthBars = 4
    @State private var activeBarIndex = -1
    @State private var timer: Timer?
    @State private var animationStartTime: Date?
    @State private var pulsate = false
    @State private var locationIconOffset: CGFloat = 20
    let activeColor = Color(hex: "#00ff81") // Brighter color if needed: #34d34b, 03ff15
    let inactiveColor = Color(hex: "#1c1c24") //2a562d // Darker background: 1c1c24 1f3d21
    let totalBars = 4
    let barAnimationInterval = 0.1 // Time interval for each bar's animation
    let cycleWaitTime = 1.0 // Wait time before starting the animation again
    let totalAnimationDuration = 120.0 // Total duration of the animation
    let pauseDuration = 10.0 // Duration of the pause
    
    private func startVisibilityTimer() {
        if signalStrength == totalBars {
            // Start a timer to hide the signal bars after 30 seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                // Only hide if the signal strength is still full
                if signalStrengthBars == totalBars {
                    showSignalBars = false
                }
            }
        } else {
            showSignalBars = true
        }
    }
    
    private var signalStrength: Int {
        guard let accuracy = accuracy else {
            return 0
        }
        
        let accuracyInFeet = accuracy * 3.28084
        if accuracyInFeet > 500 || accuracy == 0 || accuracyInFeet == 0 {
            return 0
        }
        
        switch accuracyInFeet {
        case 0..<50:
            return 4
        case 50..<100:
            return 3
        case 100..<150:
            return 2
        default:
            return 1
        }
    }
    
    private var signalColor: Color {
        switch signalStrength {
        case 4, 3, 2:
            return Color(hex: "#05df73")
        default:
            return Color(hex: "#05df73")
        }
    }
    
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<totalBars, id: \.self) { index in
                VStack {
                    Spacer()
                    if signalStrength == 0 {
                        SignalBarView(height: CGFloat(5 * (index + 1)),
                                      color: index == activeBarIndex ? activeColor : inactiveColor)
                    } else {
                        SignalBarView(height: CGFloat(5 * (index + 1)),
                                      color: index < signalStrength ? activeColor : inactiveColor)
                    }
                }
            }
            .offset(y: -35)
            .offset(x: 20)
            .opacity(showSignalBars ? 1 : 0)
            .animation(.easeInOut, value: showSignalBars)
            
            Spacer(minLength: 2)
            
            Image(systemName: signalStrength == 4 ? "location.fill" : (showSignalBars ? (signalStrength > 0 ? "location" : "location.slash") : "location"))
                .foregroundColor((signalStrength > 0 && showSignalBars) || signalStrength == 4 ? Color(hex: "#00ff81") : Color(hex: "#Ff0303")) // Green when above 1 bar, otherwise, red
                .offset(x: locationIconOffset, y: -33)
                .animation(.easeInOut, value: locationIconOffset)
        }
        .frame(height: 25)
        .onAppear {
            pulsate = true
            startVisibilityTimer()
        }
        .onChange(of: signalStrength) {
            if signalStrength == 0 {
                animationStartTime = Date()
                activateBars()
            }
            startVisibilityTimer()
        }
        .onChange(of: showSignalBars) { newValue, _ in
            locationIconOffset = newValue ? -35 : 20
        }
        .onDisappear {
            timer?.invalidate()
        }
        
        Image(systemName: "circle.fill")
            .foregroundColor(Color(UIColor(hex: "#00ff81")))
            .offset(x: 13, y: -35)
            .opacity(pulsate ? 0.3 : 1)
            .animation(Animation.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulsate)
            .onAppear {
                pulsate = true
            }
            .onAppear {
                if signalStrength == 0 {
                    animationStartTime = Date()
                    activateBars()
                }
            }
            .onDisappear {
                timer?.invalidate()
            }
    }
    
    struct SignalBarView: View {
        var height: CGFloat
        var color: Color
        
        var body: some View {
            Rectangle()
                .frame(width: 8, height: height)
                .foregroundColor(color)
                .cornerRadius(2)
        }
    }
    
    private func activateBars() {
        activeBarIndex = -1
        timer?.invalidate()
        var currentBarIndex = 0
        
        timer = Timer.scheduledTimer(withTimeInterval: barAnimationInterval, repeats: true) { _ in
            let elapsed = Date().timeIntervalSince(self.animationStartTime ?? Date())
            if elapsed > self.totalAnimationDuration {
                self.timer?.invalidate()
                return
            }
            if currentBarIndex < self.totalBars {
                withAnimation {
                    self.activeBarIndex = currentBarIndex
                }
                currentBarIndex += 1
            } else {
                // Reset after last bar
                withAnimation {
                    self.activeBarIndex = -1
                }
                currentBarIndex = 0
                self.timer?.invalidate()
                
                DispatchQueue.main.asyncAfter(deadline: .now() + self.cycleWaitTime) {
                    if elapsed + self.cycleWaitTime <= self.totalAnimationDuration {
                        self.activateBars()
                        
                    }
                }
            }
        }
    }
}
