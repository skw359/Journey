import WatchKit
import SwiftUI

struct SpeedometerView: View {
    let currentSpeed: Double
    let targetSpeed: Int
    
    @State private var animatedSpeed: Double = 0
    
    private let arcColor = Color.white
    private let needleColor = Color(hex: "#00ff81")
    
    var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let center = CGPoint(x: geometry.size.width / 2, y: geometry.size.height / 2)
            
            ZStack {
                // Background arc
                Circle()
                    .trim(from: 0, to: 0.75)  // 270 degrees
                    .stroke(arcColor.opacity(0.3), lineWidth: size * 0.03)
                    .rotationEffect(.degrees(135))
                
                // Colored arc from 7 o'clock to current position
                Circle()
                    .trim(from: 0, to: CGFloat(min(animatedSpeed / Double(targetSpeed), 1)) * 0.75)
                    .stroke(needleColor, lineWidth: size * 0.03)
                    .rotationEffect(.degrees(135))
                
                // Extended needle
                ExtendedNeedle(speed: animatedSpeed, maxSpeed: Double(targetSpeed))
                    .fill(needleColor)
                    .rotationEffect(.degrees(135))
                
                // Speed display
                Text("\(Int(currentSpeed))")
                    .font(.system(size: size * 0.2, weight: .bold))
                    .foregroundColor(.white)
                    .offset(y: size * 0.25)
                
                // MPH label
                Text("mph")
                    .font(.system(size: size * 0.05, weight: .regular))
                    .foregroundColor(.white)
                    .offset(y: size * 0.09)
                
                // Green dot in the center
                Circle()
                    .fill(Color.green)
                    .frame(width: size * 0.05, height: size * 0.05)
            }
            .frame(width: size, height: size)
            .position(center)
        }
        .aspectRatio(1, contentMode: .fit)
        .onChange(of: currentSpeed) { _, newSpeed in
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                animatedSpeed = newSpeed
            }
        }
    }
}

struct ExtendedNeedle: Shape {
    var speed: Double
    var maxSpeed: Double
    
    var animatableData: Double {
        get { speed }
        set { speed = newValue }
    }
    
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        let angle = .pi * 1.5 * (speed / maxSpeed)  // 270 degrees (1.5 * π)
        
        let arcWidth = radius * 0.03
        let needleWidth = arcWidth
        let splitGap = needleWidth * 0.3
        
        // Calculate points for the needle
        let innerRadius = radius * 0.1
        let outerRadius = radius + needleWidth / 2
        let splitStartRadius = innerRadius + (outerRadius - innerRadius) * 0.1
        
        let innerPoint = CGPoint(
            x: center.x + CGFloat(cos(angle)) * innerRadius,
            y: center.y + CGFloat(sin(angle)) * innerRadius
        )
        let splitStartPoint = CGPoint(
            x: center.x + CGFloat(cos(angle)) * splitStartRadius,
            y: center.y + CGFloat(sin(angle)) * splitStartRadius
        )
        let outerPoint = CGPoint(
            x: center.x + CGFloat(cos(angle)) * outerRadius,
            y: center.y + CGFloat(sin(angle)) * outerRadius
        )
        
        // Calculate offset for the split
        let offsetX = CGFloat(sin(angle)) * (splitGap / 2)
        let offsetY = -CGFloat(cos(angle)) * (splitGap / 2)
        
        // Draw the left (outer) edge of the needle
        path.move(to: innerPoint)
        path.addLine(to: splitStartPoint)
        path.addLine(to: CGPoint(x: outerPoint.x - offsetX, y: outerPoint.y - offsetY))
        
        // Draw the right (inner) edge of the needle
        path.move(to: innerPoint)
        path.addLine(to: splitStartPoint)
        path.addLine(to: CGPoint(x: outerPoint.x + offsetX, y: outerPoint.y + offsetY))
        
        return path.strokedPath(StrokeStyle(lineWidth: needleWidth, lineCap: .round, lineJoin: .round))
    }
}
