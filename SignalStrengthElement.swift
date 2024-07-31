import Foundation
import SwiftUI

struct SignalStrengthElement: View {
    var accuracy: CLLocationAccuracy?
    @State private var showSignalBars = true
    @State private var signalStrengthBars = 4
    @State private var activeBarIndex = -1
    @State private var timer: Timer?
    @State private var animationStartTime: Date?
    @State private var locationIconOffset: CGFloat = 20
    @State private var calculatedFinalOffset: CGFloat = -35 // Default value, will be updated
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
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
        GeometryReader { geometry in
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
                .offset(y: WKInterfaceDevice.current().screenBounds.width == 176.0 ? -32 : -35) // basically if this is running on a 41mm screen, adjust the offset to -32
                .offset(x: 20)
                .opacity(showSignalBars ? 1 : 0)
                .animation(.easeInOut, value: showSignalBars)
                
                Spacer(minLength: 2)
                
                if WKInterfaceDevice.current().screenBounds.width != 176.0 { // 41mm screen width, if it's running on that, then disappear satellites icon to save screen space
                    Image("satellites")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 20, height: 20)
                        .foregroundColor((signalStrength > 0 && showSignalBars) || signalStrength == 4 ? Color(hex: "#00ff81") : Color(hex: "#Ff0303"))
                        .offset(x: locationIconOffset, y: -33)
                        .animation(.easeInOut, value: locationIconOffset)
                }
            }
            .frame(height: 25)
            .onAppear {
                calculatedFinalOffset = -(geometry.size.width - 27)
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
                locationIconOffset = newValue ? calculatedFinalOffset : 20
            }
            .onDisappear {
                timer?.invalidate()
            }
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
