import SwiftUI
import WatchKit

struct CompassScreen: View {
    @ObservedObject var viewModel: LocationManager
    @State private var arrowColor: Color = .red
    @State private var showRecalibratingMessage = false
    @State private var showCalibrationInstructions = false
    let compassSize: CGFloat = 125
    let dialRadius: CGFloat = 62.5
    @State private var overlayOpacity: Double = 0
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // Main compass view
                ZStack {
                    Circle()
                        .stroke(lineWidth: 0)
                        .foregroundColor(.gray)
                    
                    // Major lines with labels
                    ForEach(0..<24) { index in
                        Group {
                            let isMajorDirection = index % 6 == 0
                            let directionColor = self.colorForDirection(at: index)
                            
                            Rectangle()
                                .fill(directionColor)
                                .frame(width: 2, height: isMajorDirection ? 15 : 5)
                                .offset(y: -(dialRadius))
                                .rotationEffect(.degrees(self.lineAngle(for: index)))
                            
                            // Direction labels (N, E, S, W)
                            if isMajorDirection {
                                Text(self.directionLabel(for: index))
                                    .foregroundColor(directionColor)
                                    .offset(y: -(dialRadius + 20))
                                    .rotationEffect(.degrees(-Double(index) * 15))
                            }
                        }
                    }
                }
                .frame(width: compassSize, height: compassSize)
                .rotationEffect(.degrees(-viewModel.heading))
                
                Circle()
                        .fill(Color.green)
                        .frame(width: 10, height: 10)
                        .gesture(
                            LongPressGesture(minimumDuration: 1.0)
                                .onEnded { _ in
                                    self.recalibrateCompass()
                                }
                        )
                
                Text(headingText())
                    .foregroundColor(.white)
                    .font(.caption)
                    .offset(y:100)
            }
            .overlay(
                Triangle()
                    .fill(viewModel.alignedWithCardinalDirection() ? Color.green : Color.red)
                    .frame(width: 20, height: 20)
                    .offset(y: -(dialRadius + -70)),
                alignment: .top
            )
            .frame(width: geometry.size.width, height: geometry.size.height)
            
            
            // Calibration instructions overlay
            if showCalibrationInstructions || showRecalibratingMessage {
                ZStack {
                    Color.black.opacity(0.95)
                        .edgesIgnoringSafeArea(.all)
                    
                    VStack {
                        Spacer()
                        
                        if showCalibrationInstructions {
                            VStack {
                                Text("Calibrate Compass")
                                    .font(.headline)
                                Text("Move your device in a figure-8 pattern to calibrate the compass.")
                                    .multilineTextAlignment(.center)
                                Image(systemName: "figure.8")
                                    .font(.largeTitle)
                            }
                            .padding()
                            .foregroundColor(.white)
                            .cornerRadius(10)
                        }
                        
                        Spacer()
                        
                        if showRecalibratingMessage {
                            ShimmeringText(text: "Recalibrating...", baseColor: Color(hex: "#7a7a7a"), shimmerColor: .white)
                                .padding()
                                .cornerRadius(10)
                        }
                        
                        Spacer().frame(height: 30)
                            .transition(.opacity)
                    }
                    
                }
                .opacity(overlayOpacity)
                .animation(.easeInOut(duration: 0.5), value: overlayOpacity)
                .frame(width: geometry.size.width, height: geometry.size.height)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("ShowCalibrationInstructions"))) { _ in
            self.showCalibrationInstructions = true
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("CalibrationComplete"))) { _ in
            self.showCalibrationInstructions = false
        }
        .onChange(of: viewModel.isRecalibrating) { oldValue, newValue in
            if newValue {
                withAnimation(.easeInOut(duration: 0.5)) {
                    overlayOpacity = 1
                }
                showRecalibratingMessage = true
            } else {
                withAnimation(.easeInOut(duration: 0.5)) {
                    overlayOpacity = 0
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    showRecalibratingMessage = false
                }
            }
        }
        .edgesIgnoringSafeArea(.all)
    }
    
    private func recalibrateCompass() {
        vibrate(.click)
        withAnimation(.easeInOut(duration: 0.5)) {
            overlayOpacity = 1
        }
        viewModel.recalibrateCompass()
    }
    
    private func endRecalibration() {
        vibrate(.success)
        withAnimation(.easeInOut(duration: 0.5)) {
            overlayOpacity = 0
        }
    }
    
    private func vibrate(_ type: WKHapticType) {
        WKInterfaceDevice.current().play(type)
    }
    
    private func changeArrowColor() {
        withAnimation(.easeInOut(duration: 0.5)) {
            if viewModel.alignedWithCardinalDirection() {
                arrowColor = .green
            } else {
                arrowColor = .red
            }
        }
    }
    
    private func directionLabel(for index: Int) -> String {
        switch index {
        case 0: return "N"
        case 6: return "W"
        case 12: return "S"
        case 18: return "E"
        default: return ""
        }
    }
    
    private func headingText() -> String {
        let heading = viewModel.heading
        let direction = self.directionFromBearing(heading)
        return String(format: "%.0f° %@", heading, direction)
    }
    private func directionFromBearing(_ bearing: Double) -> String {
        let directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        let index = Int((bearing / 45).rounded()) % 8
        return directions[index]
    }
    private func lineAngle(for index: Int) -> Double {
        switch index {
        case 6: return 270.0  // West
        case 18: return 90.0  // East
        default: return Double(index * 15)
        }
    }
    
    func colorForDirection(at index: Int) -> Color {
        let currentHeading = viewModel.heading
        
        let adjustedHeading = (currentHeading + 360).truncatingRemainder(dividingBy: 360)
        
        switch index {
        case 0:  // North
            return (adjustedHeading <= 10 || adjustedHeading >= 350) ? Color.green : Color.white
        case 6:  // West
            return (adjustedHeading >= 260 && adjustedHeading <= 280) ? Color.green : Color.white
        case 12: // South
            return (adjustedHeading >= 170 && adjustedHeading <= 190) ? Color.green : Color.white
        case 18: // East
            return (adjustedHeading >= 80 && adjustedHeading <= 100) ? Color.green : Color.white
        default:
            return Color.gray
        }
    }
    
}

struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLines([
            CGPoint(x: rect.minX, y: rect.maxY),
            CGPoint(x: rect.maxX, y: rect.maxY),
            CGPoint(x: rect.midX, y: rect.minY)
        ])
        path.closeSubpath()
        return path
    }
}

extension LocationManager {
    func alignedWithCardinalDirection() -> Bool {
        let northRange: ClosedRange<Double> = 350.0...360.0
        let northLowerBound: ClosedRange<Double> = 0.0...10.0
        let otherCardinalDirections: [Double] = [90, 180, 270] // East, South, West
        
        if northRange.contains(self.heading) || northLowerBound.contains(self.heading) {
            return true
        }
        
        return otherCardinalDirections.contains { abs(self.heading - $0) <= 10.0 }
    }
}
