import WatchKit
import SwiftUI

struct SpeedometerView: View {
    let currentSpeed: Double
    let targetSpeed: Int
    let elapsedTime: TimeInterval
    let formatTime: (TimeInterval) -> String
    
    @State private var animatedSpeed: Double = 0
    
    private let arcColor = Color.white
    private let needleColor = Color(hex: "#00ff81")
    
    var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let center = CGPoint(x: geometry.size.width / 2, y: geometry.size.height / 2)
            
            ZStack {
                // Background arc, 270 degrees
                Circle()
                    .trim(from: 0, to: 0.75)
                    .stroke(arcColor.opacity(0.3), lineWidth: size * 0.05)
                    .rotationEffect(.degrees(135))
                
                // Colored arc from 7 o'clock to 5 o'clock positions
                Circle()
                    .trim(from: 0, to: CGFloat(min(animatedSpeed / Double(targetSpeed), 1)) * 0.75)
                    .stroke(needleColor, lineWidth: size * 0.05)
                    .rotationEffect(.degrees(135))
                
                // Speed needle
                Needle(speed: animatedSpeed, maxSpeed: Double(targetSpeed))
                    .stroke(needleColor, lineWidth: size * 0.01)
                    .rotationEffect(.degrees(135))
                
                // Speed display
                Text("\(Int(currentSpeed))")
                    .font(.system(size: size * 0.2, weight: .bold))
                    .foregroundColor(.white)
                
                Text("mph")
                    .font(.system(size: size * 0.05, weight: .regular))
                    .foregroundColor(.white)
                    .offset(y: size * 0.15)
                
                // Timer display
                Text(formatTime(elapsedTime))
                    .font(.system(size: size * 0.05, weight: .regular))
                    .foregroundColor(.white)
                    .offset(y: size * 0.25)
                
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

struct Needle: Shape {
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
        let needlePoint = CGPoint(
            x: center.x + CGFloat(cos(angle)) * radius * 0.8,
            y: center.y + CGFloat(sin(angle)) * radius * 0.8
        )
        
        path.move(to: center)
        path.addLine(to: needlePoint)
        return path
    }
}
