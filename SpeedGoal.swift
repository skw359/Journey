import SwiftUI
import WatchKit

class SpeedTargetManager: ObservableObject {
    @Published var targetSpeed: Int = 60
    
    @Published var isSettingSpeed = false
    @Published var hitTargetSpeed = false
    @Published var waitingForGPS = false
    @Published var setSpeed = false
    @Published var targetReachedTime: Date?
    
    @Published var elapsedTime: TimeInterval = 0
    var startTime: Date?
    private var timer: Timer?
    
    func setTargetSpeed(locationManager: LocationManager, completion: @escaping () -> Void) {
        waitingForGPS = true
        isSettingSpeed = true
        hitTargetSpeed = false
        
        // Check for strong GPS signal
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            if let location = locationManager.latestLocation, location.horizontalAccuracy <= 5 {
                timer.invalidate()
                self?.waitingForGPS = false
                self?.isSettingSpeed = false
                self?.setSpeed = true
                completion()
            }
        }
    }
    
    func updateStatus(currentSpeed: Double) {
        if hitTargetSpeed {
            return  // Exit early if target speed has already been hit
        }
        
        if currentSpeed >= Double(targetSpeed) {
            hitTargetSpeed = true
            targetReachedTime = Date()
            stopTiming()
            WKInterfaceDevice.current().play(.success)
        }
    }
    
    func startTiming() {
        // Only start if not already timing
        if startTime == nil {
            startTime = Date()
            timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in
                guard let self = self, let startTime = self.startTime else { return }
                self.elapsedTime = Date().timeIntervalSince(startTime)
            }
        }
    }
    
    func stopTiming() {
        timer?.invalidate()
        timer = nil
    }
    
    func reset() {
        hitTargetSpeed = false
        elapsedTime = 0
        setSpeed = false
        startTime = nil
        stopTiming()
    }
    
    func formatTime(_ timeInterval: TimeInterval) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.minute, .second]
        formatter.unitsStyle = .positional
        formatter.zeroFormattingBehavior = .pad
        
        let hours = Int(timeInterval) / 3600
        let remainingTime = timeInterval.truncatingRemainder(dividingBy: 3600)
        let baseString = formatter.string(from: remainingTime) ?? "00:00"
        let milliseconds = Int((timeInterval.truncatingRemainder(dividingBy: 1)) * 100)
        
        if hours > 0 {
            return String(format: "%02d:%@.%02d", hours, baseString, milliseconds)
        } else {
            return String(format: "%@.%02d", baseString, milliseconds)
        }
    }
}

struct SpeedometerView: View {
    let currentSpeed: Double
    let targetSpeed: Int
    let arcColor: Color
    let needleColor: Color
    let targetReached: Bool
    
    @State private var animatedSpeed: Double = 0
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // Semi-circle arc
                Path { path in
                    path.addArc(center: CGPoint(x: geometry.size.width / 2, y: geometry.size.height),
                                radius: geometry.size.width * 0.4,
                                startAngle: .degrees(180),
                                endAngle: .degrees(0),
                                clockwise: false)
                }
                .stroke(arcColor, lineWidth: 5)
                
                // THE SPEED needle
                Needle(speed: animatedSpeed, maxSpeed: Double(targetSpeed))
                    .stroke(needleColor, lineWidth: 3)
                    .frame(width: geometry.size.width * 0.8, height: geometry.size.width * 0.4)
                    .offset(y: geometry.size.height * 0.1)
                
                // Current speed text
                Text("\(max(0, Int(currentSpeed)))")
                    .font(.system(size: 40, weight: .bold))
                    .foregroundColor(.white)
                    .position(x: geometry.size.width / 2, y: geometry.size.height - 30)
                
                // "0" mph label
                Text("0")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .position(x: geometry.size.width * 0.1, y: geometry.size.height + 10)
                
                // Target speed label
                Text("\(targetSpeed) MPH")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .position(x: geometry.size.width * 0.9, y: geometry.size.height + 10)
            }
            .frame(width: geometry.size.width, height: geometry.size.width * 0.5)
        }
        .aspectRatio(2, contentMode: .fit)
        .onChange(of: currentSpeed) { _, newSpeed in
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                animatedSpeed = newSpeed
            }
        }
    }
}

struct Needle: Shape {
    var speed: Double
    var maxSpeed: Double
    
    var animatableData: Double {
        get { speed }
        set { speed = newValue }
    }
    
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.maxY)
        let radius = min(rect.width, rect.height)
        let angle = Double.pi - Double.pi * (speed / maxSpeed)
        let needlePoint = CGPoint(
            x: center.x + CGFloat(cos(angle)) * radius,
            y: center.y - CGFloat(sin(angle)) * radius
        )
        
        path.move(to: center)
        path.addLine(to: needlePoint)
        return path
    }
}

struct SpeedGoal: View {
    @StateObject private var speedTargetManager = SpeedTargetManager()
    @ObservedObject var locationManager: LocationManager
    
    @State private var backgroundColor = Color.black
    @State private var showTargetSpeedInfo = false
    @State private var showSetTargetSpeed = false
    @State private var isBlinking = false
    @State private var showSetSpeedFromInfo = false
    
    let variableColor = Color(hex: "#00ff81")
    let blinkTimer = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()
    
    var body: some View {
        ZStack {
            backgroundColor
                .edgesIgnoringSafeArea(.all)
            
            VStack {
                if !speedTargetManager.setSpeed {
                    Spacer()
                    
                    Button(action: { showTargetSpeedInfo.toggle() }) {
                        HStack(alignment: .center, spacing: 10) {
                            Image(systemName: "questionmark.circle")
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: 20, height: 20)
                                .foregroundColor(.white)
                            
                            Text("What's this?")
                                .foregroundColor(.white)
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color(hex: "#222223"))
                        .cornerRadius(15)
                    }
                    .buttonStyle(PlainButtonStyle())
                    
                    Button(action: { showSetTargetSpeed.toggle() }) {
                        HStack(alignment: .center, spacing: 10) {
                            Image(systemName: "speedometer")
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: 20, height: 20)
                                .foregroundColor(Color(hex: "#00ff81"))
                            
                            if speedTargetManager.waitingForGPS {
                                ShimmeringText(text: "Setting Speed...", baseColor: .white)
                            } else {
                                Text("Set Speed")
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(speedTargetManager.waitingForGPS ? Color(hex: "#222223") : Color(hex: "#0c3617"))
                        .cornerRadius(15)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .disabled(speedTargetManager.waitingForGPS)
                    
                    Spacer()
                } else {
                    SpeedometerView(currentSpeed: locationManager.speed,
                                    targetSpeed: speedTargetManager.targetSpeed,
                                    arcColor: .white,
                                    needleColor: variableColor,
                                    targetReached: speedTargetManager.hitTargetSpeed)
                    .frame(height: 200)
                    .padding(.vertical, 20)
                    
                    Spacer()
                }
            }
            .padding()
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .overlay(
            VStack {
                HStack {
                    Image(systemName: "gauge.high")
                        .foregroundColor(variableColor)
                        .font(.title3)
                    Text("Speedgoal")
                        .foregroundColor(.white)
                        .font(.title3)
                        .bold()
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, speedTargetManager.setSpeed ? 55 : 0)
                Spacer()
            }
        )
        .overlay(
            Group {
                if speedTargetManager.setSpeed {
                    VStack {
                        Spacer()
                        if speedTargetManager.startTime != nil {
                            Text(speedTargetManager.formatTime(speedTargetManager.elapsedTime))
                                .font(.headline)
                                .foregroundColor(Color(hex: "#00ff81"))
                                .padding(.bottom, 40)
                                .opacity(speedTargetManager.hitTargetSpeed ? (isBlinking ? 1 : 0.3) : 1)
                                .animation(.easeInOut(duration: 0.25), value: isBlinking)
                        } else {
                            Text("Waiting...")
                                .font(.headline)
                                .foregroundColor(Color(hex: "#00ff81"))
                                .padding(.bottom, 40)
                        }
                    }
                }
            }
        )
        .sheet(isPresented: $showSetTargetSpeed) {
            ScrollView {
                SetTargetSpeedSheet(
                    targetSpeed: $speedTargetManager.targetSpeed,
                    waitingForGPS: $speedTargetManager.waitingForGPS
                ) {
                    speedTargetManager.setTargetSpeed(locationManager: locationManager) {
                        showSetTargetSpeed = false
                        speedTargetManager.setSpeed = true
                    }
                }
            }
        }
        .sheet(isPresented: $showTargetSpeedInfo) {
            ScrollView {
                SpeedGoalInfoSheet {
                    showTargetSpeedInfo = false
                    showSetSpeedFromInfo = true
                }
            }
        }
        .sheet(isPresented: $showSetSpeedFromInfo) {
            ScrollView {
                SetTargetSpeedSheet(
                    targetSpeed: $speedTargetManager.targetSpeed,
                    waitingForGPS: $speedTargetManager.waitingForGPS
                ) {
                    speedTargetManager.setTargetSpeed(locationManager: locationManager) {
                        showSetSpeedFromInfo = false
                        speedTargetManager.setSpeed = true
                    }
                }
            }
        }
        .onReceive(locationManager.$speed) { speed in
            let nonNegativeSpeed = max(0, speed)
            speedTargetManager.updateStatus(currentSpeed: nonNegativeSpeed)
            
            // Start timing if speed is 2+ mph and timer hasn't started yet
            if nonNegativeSpeed >= 2 {
                speedTargetManager.startTiming()
            }
        }
        .onReceive(blinkTimer) { _ in
            if speedTargetManager.hitTargetSpeed {
                isBlinking.toggle()
            }
        }
        .onChange(of: speedTargetManager.hitTargetSpeed) {
            if !speedTargetManager.hitTargetSpeed {
                isBlinking = false
            }
        }
    }
}

struct SpeedGoalInfoSheet: View {
    var onSetSpeed: () -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What's this?")
                .font(.headline)
                .bold()
            
            Text("Target Speed allows you to set a desired speed and then automatically starts timing your acceleration.")
            Text("For example, if you want to measure how long it takes to go from 0 to 60 mph, you would set 60 mph as the target. Once movement is detected, the timer automatically starts and continues until you reach 60 mph. This can be useful for users who want to quantify acceleration times, athletes tracking sprint starts, or evaluating efficiency of different propulsion systems.")
            
            Spacer()
            
            Button(action: onSetSpeed) {
                HStack(alignment: .center, spacing: 10) {
                    Image(systemName: "speedometer")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 20, height: 20)
                        .foregroundColor(Color(hex: "#00ff81"))
                    
                    Text("Set Speed")
                        .foregroundColor(.white)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color(hex: "#0c3617"))
                .cornerRadius(15)
            }
            .buttonStyle(PlainButtonStyle())
        }
        .padding()
    }
}

struct SetTargetSpeedSheet: View {
    @Binding var targetSpeed: Int
    @Binding var waitingForGPS: Bool
    var onSetSpeed: () -> Void
    
    var body: some View {
        VStack {
            Text("Target Speed")
                .font(.title2)
                .padding()
                .bold()
            
            Text("Tap and scroll to set your desired target speed.")
                .foregroundColor(.gray)
                .padding(.bottom)
            
            Picker("Target Speed", selection: $targetSpeed) {
                ForEach(3...1150, id: \.self) { speed in
                    Text("\(speed) mph")
                }
            }
            .pickerStyle(WheelPickerStyle())
            .frame(height: 55)
            
            Button(action: onSetSpeed) {
                HStack {
                    Image(systemName: "checkmark.circle")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 20, height: 20)
                        .foregroundColor(.white)
                    
                    if waitingForGPS {
                        ShimmeringText(text: "Setting Speed...", baseColor: .white)
                    } else {
                        Text("Set Speed")
                            .foregroundColor(.white)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(waitingForGPS ? Color(hex: "#222223") : Color(hex: "#222223"))
                .cornerRadius(15)
            }
            .buttonStyle(PlainButtonStyle())
            .padding(.horizontal)
            .disabled(waitingForGPS)
        }
        .padding(.bottom, 20)
    }
}
