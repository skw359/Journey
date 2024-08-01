import SwiftUI
import WatchKit

class SpeedTargetManager: ObservableObject {
    @Published var targetSpeed: Int = 60
    
    @Published var isSettingSpeed = false
    @Published var hitTargetSpeed = false
    @Published var reliableSpeed = false
    @Published var isWaitingForGPS = false
    @Published var setSpeed = false
    @Published var targetReachedTime: Date?
    
    func setTargetSpeed(locationManager: LocationManager) {
        isWaitingForGPS = true
        isSettingSpeed = true
        hitTargetSpeed = false
        reliableSpeed = false
        
        // Check for strong GPS signal
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            if let location = locationManager.latestLocation, location.horizontalAccuracy <= 5 {
                timer.invalidate()
                self?.isWaitingForGPS = false
                self?.isSettingSpeed = false
                self?.setSpeed = true
            }
        }
    }
    
    func updateStatus(currentSpeed: Double) {
        if !hitTargetSpeed {
            if currentSpeed < 2 { //start mph
                reliableSpeed = false
            } else if !reliableSpeed {
                reliableSpeed = true
            }
            
            if reliableSpeed {
                if currentSpeed < Double(targetSpeed) {
                    // Not reached yet
                } else {
                    hitTargetSpeed = true
                    targetReachedTime = Date()
                    WKInterfaceDevice.current().play(.success)
                }
            }
        }
    }
    
    func reset() {
        hitTargetSpeed = false
        reliableSpeed = false
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

struct SpeedTarget: View {
    @StateObject private var speedTargetManager = SpeedTargetManager()
    @ObservedObject var locationManager: LocationManager
    
    @State private var backgroundColor = Color.black
    @State private var showTargetSpeedInfo = false
    @State private var showSetTargetSpeed = false
    @State private var setSpeed = false
    @State private var elapsedTimeString = "Awaiting activity..."
    @State private var timerStartDate: Date?
    @State private var isBlinking = false
    @State private var showSetSpeedFromInfo = false
    
    let variableColor = Color(hex: "#00ff81")
    let timer = Timer.publish(every: 0.01, on: .main, in: .common).autoconnect()
    let blinkTimer = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()
    
    var body: some View {
        ZStack {
            backgroundColor
                .edgesIgnoringSafeArea(.all)
            
            VStack {
                if !setSpeed {
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
                            
                            if speedTargetManager.isWaitingForGPS {
                                ShimmeringText(text: "Setting Speed...", baseColor: .white)
                            } else {
                                Text("Set Speed")
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(speedTargetManager.isWaitingForGPS ? Color(hex: "#222223") : Color(hex: "#0c3617"))
                        .cornerRadius(15)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .disabled(speedTargetManager.isWaitingForGPS)
                    
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
                .padding(.top, setSpeed ? 55 : 0)
                Spacer()
            }
        )
        .overlay(
            Group {
                if setSpeed {
                    VStack {
                        Spacer()
                        Text(elapsedTimeString)
                            .font(.headline)
                            .foregroundColor(Color(hex: "#00ff81"))
                            .padding(.bottom, 40)
                            .opacity(speedTargetManager.hitTargetSpeed ? (isBlinking ? 1 : 0.3) : 1)
                            .animation(.easeInOut(duration: 0.25), value: isBlinking)
                    }
                }
            }
        )
        .sheet(isPresented: $showSetTargetSpeed) {
            ScrollView {
                VStack {
                    Text("Target Speed")
                        .font(.title2)
                        .padding()
                        .bold()
                    
                    Text("Tap and scroll to set your desired target speed.")
                        .foregroundColor(.gray)
                        .padding(.bottom)
                    
                    Picker("Target Speed", selection: $speedTargetManager.targetSpeed) {
                        ForEach(3...1150, id: \.self) { speed in
                            Text("\(speed) mph")
                        }
                    }
                    .pickerStyle(WheelPickerStyle())
                    .frame(height: 55)
                    
                    Button(action: {
                        speedTargetManager.setTargetSpeed(locationManager: locationManager)
                    }) {
                        HStack {
                            Image(systemName: "checkmark.circle")
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: 20, height: 20)
                                .foregroundColor(.white)
                            
                            if speedTargetManager.isWaitingForGPS {
                                ShimmeringText(text: "Setting Speed...", baseColor: .white)
                            } else {
                                Text("Set Speed")
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(speedTargetManager.isWaitingForGPS ? Color(hex: "#222223") : Color(hex: "#222223"))
                        .cornerRadius(15)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .padding(.horizontal)
                    .disabled(speedTargetManager.isWaitingForGPS)
                }
                .padding(.bottom, 20)
            }
        }
        .sheet(isPresented: $showTargetSpeedInfo) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("What's this?")
                        .font(.headline)
                        .bold()
                    
                    Text("Target Speed allows you to set a desired speed and then automatically starts timing your acceleration.")
                    Text("For example, if you want to measure how long it takes to go from 0 to 60 mph, you would set 60 mph as the target. Once movement is detected, the timer automatically starts and continues until you reach 60 mph. This can be useful for users who want to quantify acceleration times, athletes tracking sprint starts, or evaluating efficiency of different propulsion systems.")
                    
                    Spacer()
                    
                    Button(action: {
                        showTargetSpeedInfo = false
                        showSetSpeedFromInfo = true
                    }) {
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
        .sheet(isPresented: $showSetSpeedFromInfo) {
            ScrollView {
                VStack {
                    Text("Target Speed")
                        .font(.title2)
                        .padding()
                        .bold()
                    
                    Text("Tap and scroll to set your desired target speed.")
                        .foregroundColor(.gray)
                        .padding(.bottom)
                    
                    Picker("Target Speed", selection: $speedTargetManager.targetSpeed) {
                        ForEach(3...1150, id: \.self) { speed in
                            Text("\(speed) mph")
                        }
                    }
                    .pickerStyle(WheelPickerStyle())
                    .frame(height: 55)
                    
                    Button(action: {
                        speedTargetManager.setTargetSpeed(locationManager: locationManager)
                        showSetSpeedFromInfo = false
                    }) {
                        HStack {
                            Image(systemName: "checkmark.circle")
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: 20, height: 20)
                                .foregroundColor(.white)
                            
                            if speedTargetManager.isWaitingForGPS {
                                ShimmeringText(text: "Setting Speed...", baseColor: .white)
                            } else {
                                Text("Set Speed")
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(speedTargetManager.isWaitingForGPS ? Color(hex: "#222223") : Color(hex: "#222223"))
                        .cornerRadius(15)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .padding(.horizontal)
                    .disabled(speedTargetManager.isWaitingForGPS)
                }
                .padding(.bottom, 20)
            }
        }
        .onChange(of: speedTargetManager.setSpeed) {
            showSetTargetSpeed = !speedTargetManager.setSpeed
            setSpeed = speedTargetManager.setSpeed
        }
        .onReceive(locationManager.$speed) { speed in
            let nonNegativeSpeed = max(0, speed)
            speedTargetManager.updateStatus(currentSpeed: nonNegativeSpeed)
            
            if timerStartDate == nil && nonNegativeSpeed >= 2 {
                timerStartDate = Date()
            }
        }
        .onReceive(timer) { _ in
            if let startDate = timerStartDate {
                let elapsed: TimeInterval
                if let reachedTime = speedTargetManager.targetReachedTime {
                    elapsed = reachedTime.timeIntervalSince(startDate)
                } else {
                    elapsed = Date().timeIntervalSince(startDate)
                }
                elapsedTimeString = speedTargetManager.formatTime(elapsed)
            } else {
                elapsedTimeString = "Awaiting activity..."
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
