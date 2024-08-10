import SwiftUI
import WatchKit

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

struct SpeedGoalScreen: View {
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
                    GeometryReader { geometry in
                        VStack {
                            Spacer()
                            
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
                            .offset(y: geometry.size.height / 396 * 20 - 15)
                            
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
                                        .foregroundColor(variableColor)
                                    
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
                        }
                    }
                } else {
                    // Existing code for when speed is set
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
            Group {
                if speedTargetManager.setSpeed {
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
                        .padding(.top, 55)
                        Spacer()
                    }
                }
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
            
            if nonNegativeSpeed >= 2 && speedTargetManager.setSpeed {
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

