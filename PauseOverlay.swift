import SwiftUI

struct PauseOverlay: View {
    var size: CGSize
    
    var body: some View {
        ZStack {
            Color.black.opacity(0.95)
            
            VStack(spacing: 20) {
                Image(systemName: "pause.circle.fill")
                    .font(.system(size: size.width * 0.2))
                    .foregroundColor(.white)
                
                Text("Journey Paused")
                    .font(.system(size: size.width * 0.08, weight: .bold))
                    .foregroundColor(.white)
            }
        }
        .frame(width: size.width, height: size.height)
    }
}

struct PauseOverlayModifier: ViewModifier {
    @ObservedObject var locationManager: LocationManager
    
    func body(content: Content) -> some View {
        GeometryReader { geometry in
            ZStack {
                content
                
                PauseOverlay(size: geometry.size)
                    .opacity(locationManager.paused ? 1 : 0)
                    .animation(.easeInOut(duration: 0.35), value: locationManager.paused)
                    .allowsHitTesting(locationManager.paused)
            }
        }
    }
}

extension View {
    func pauseOverlay(locationManager: LocationManager) -> some View {
        self.modifier(PauseOverlayModifier(locationManager: locationManager))
    }
}
