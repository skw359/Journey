import SwiftUI

struct LoadingView: View {
    @State private var isAnimating = false
    
    let animation = Animation.timingCurve(0.5, 0.4, 0.2, 0.5, duration: 1.2)
        .repeatForever(autoreverses: false)
    
    var body: some View {
        ZStack {
            Circle() // Static background ring
                .stroke(lineWidth: 5)
                .opacity(0.3)
                .foregroundColor(Color.blue)
            
            Circle() // Animated foreground ring
                .trim(from: 0, to: 0.2)
                .stroke(Color.blue, lineWidth: 5)
                .rotationEffect(Angle(degrees: isAnimating ? 235 : -125))
                .animation(animation, value: isAnimating)
                .onAppear() {
                    isAnimating = true
                }
        }
        .frame(width: 25, height: 25)
    }
}
// Animation.timingCurve(0.5, 0.4, 0.5, 1.0, duration: 2)
