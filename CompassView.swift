import SwiftUI

struct CompassView: View {
    @StateObject var locationManager = LocationManager()
    @ObservedObject var viewModel: LocationManager
    @State private var arrowColor: Color = .red
    @State private var triangleColor: Color = .red
    
    let compassSize: CGFloat = 125
    let dialRadius: CGFloat = 62.5 // Half the size of the compass for the radius
    
    var body: some View {
        ZStack {
            // Rotating compass dial with markings
            ZStack {
                // Outer circle for the compass dial
                Circle()
                    .stroke(lineWidth: 0)
                    .foregroundColor(.gray)
                
                // Major lines with labels
                ForEach(0..<24) { index in
                    Group {
                        // Determine if this is a major direction
                        let isMajorDirection = index % 6 == 0
                        // Calculate the correct color based on the current heading
                        let directionColor = self.colorForDirection(at: index)
                        
                        // Draw the major and minor lines
                        Rectangle()
                            .fill(directionColor)
                            .frame(width: 2, height: isMajorDirection ? 15 : 5)
                            .offset(y: -(dialRadius))
                            .rotationEffect(.degrees(self.correctedLineAngle(for: index)))
                        
                        // Add the direction labels (N, E, S, W)
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
            .rotationEffect(.degrees(-viewModel.heading)) // Rotate the entire compass based on the heading
            
            // Center point indicator
            Circle()
                .fill(Color.green)
                .frame(width: 10, height: 10)
            Text(headingText())
                .foregroundColor(.white)
                .font(.caption)
            // .padding(.top, 8)
                .offset(y:100)
        }
        // Fixed direction indicator (Triangle) placed outside the rotating ZStack
        .overlay(
            Triangle()
                .fill(viewModel.isAlignedWithCardinalDirection() ? Color.green : Color.red)
                .frame(width: 20, height: 20)
                .offset(y: -(dialRadius + -70)), // Position it directly centered above the orange circle
            alignment: .top
        )
        .onReceive(locationManager.$heading) { _ in
            updateArrowColor()
        }
    }
    private func updateArrowColor() {
        withAnimation(.easeInOut(duration: 0.5)) {
            if viewModel.isAlignedWithCardinalDirection() {
                arrowColor = .green
            } else {
                arrowColor = .red
            }
        }
    }
    
    // Return the correct label for the direction
    func directionLabel(for index: Int) -> String {
        switch index {
        case 0: return "N"
        case 6: return "W"
        case 12: return "S"
        case 18: return "E"
        default: return ""
        }
    }
    
    func headingText() -> String {
        let heading = viewModel.heading
        let direction = self.directionFromBearing(heading)
        return String(format: "%.0f° %@", heading, direction)
    }
    func directionFromBearing(_ bearing: Double) -> String {
        let directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        let index = Int((bearing / 45).rounded()) % 8
        return directions[index]
    }
    func correctedLineAngle(for index: Int) -> Double {
        switch index {
        case 6: return 270.0  // West
        case 18: return 90.0  // East
        default: return Double(index * 15)
        }
    }
    
    func colorForDirection(at index: Int) -> Color {
        let currentHeading = viewModel.heading
        
        // Adjust for the rotation of the compass
        let adjustedHeading = (currentHeading + 360).truncatingRemainder(dividingBy: 360)
        
        // Determine the color based on the adjusted heading
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
    func isAlignedWithCardinalDirection() -> Bool {
        let northRange: ClosedRange<Double> = 350.0...360.0
        let northLowerBound: ClosedRange<Double> = 0.0...10.0
        let otherCardinalDirections: [Double] = [90, 180, 270] // East, South, West
        
        if northRange.contains(self.heading) || northLowerBound.contains(self.heading) {
            return true
        }
        
        return otherCardinalDirections.contains { abs(self.heading - $0) <= 10.0 }
    }
}







