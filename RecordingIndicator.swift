import SwiftUI

struct RecordingIndicator: View {
    @State private var pulsate = false
    
    var body: some View {
        Image(systemName: "circle.fill")
            .foregroundColor(Color(hex: "00ff81"))
            .font(.system(size: 20))
            .opacity(pulsate ? 0.3 : 1)
            .animation(Animation.easeInOut(duration: 1).repeatForever(autoreverses: true), value: pulsate)
            .onAppear {
                pulsate = true
            }
    }
}
