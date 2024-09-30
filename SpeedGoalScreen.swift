import WatchKit
import SwiftUI

struct SpeedGoalScreen: View {
    @StateObject private var speedTargetManager = SpeedTargetManager()
    @ObservedObject var locationManager: LocationManager
    @State private var backgroundColor = Color.black
    @State private var showTargetSpeedInfo = false
    @State private var showSetTargetSpeed = false
    @State private var timerBlinking = false
    @State private var showSetSpeedFromInfo = false
    
    let buttonColor = Color(hex: "#00ff81")
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
                                    .foregroundColor(buttonColor)
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
                                        .foregroundColor(buttonColor)
                                    
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
                    // Speedometer view
                    SpeedometerView(
                        currentSpeed: locationManager.speed,
                        targetSpeed: speedTargetManager.targetSpeed,
                        SpeedGoalSettingsPressed: {
                            showSetTargetSpeed = true
                        }
                    )
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
                if speedTargetManager.setSpeed && !speedTargetManager.hitTargetSpeed {
                    VStack {
                        Spacer()
                        if speedTargetManager.startTime != nil {
                            Text(speedTargetManager.formatTime(speedTargetManager.elapsedTime))
                                .font(.headline)
                                .foregroundColor(buttonColor)
                                .padding(.bottom, 40)
                        } else {
                            Text("")
                                .font(.headline)
                                .foregroundColor(buttonColor)
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
                        speedTargetManager.hitTargetSpeed = false
                        // Update the target speed while in motion
                        speedTargetManager.updateStatus(currentSpeed: locationManager.speed)
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
                        speedTargetManager.hitTargetSpeed = false
                        // Update the target speed while in motion
                        speedTargetManager.updateStatus(currentSpeed: locationManager.speed)
                    }
                }
            }
        }
        .onReceive(locationManager.$speed) { speed in
            let nonNegativeSpeed = max(0, speed)
            speedTargetManager.updateStatus(currentSpeed: nonNegativeSpeed)
            
            if nonNegativeSpeed >= 2 && speedTargetManager.setSpeed && !speedTargetManager.hitTargetSpeed {
                speedTargetManager.startTiming()
            }
        }
        .onReceive(blinkTimer) { _ in
            if speedTargetManager.hitTargetSpeed {
                timerBlinking.toggle()
            }
        }
        .onChange(of: speedTargetManager.hitTargetSpeed) { oldValue, newValue in
            if !newValue {
                timerBlinking = false
            }
        }
    }
}
