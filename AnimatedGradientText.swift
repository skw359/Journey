import SwiftUI

struct AnimatedGradientText: View {
    let text: String
    @State private var animate = false
    @State private var timer: Timer?

    var body: some View {
        ZStack {
            Text(text)
                .foregroundColor(.white)
                .font(.title2)
                .bold()
                .overlay(
                    GeometryReader { geometry in
                        LinearGradient(gradient: Gradient(colors: [.clear, Color(hex: "#05e87a"), .clear]),
                                       startPoint: .leading,
                                       endPoint: .trailing)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .offset(x: animate ? geometry.size.width : -geometry.size.width)
                            .onAppear {
                                startAnimation(geometry: geometry)
                            }
                    }
                    .mask(Text(text).foregroundColor(.white))
                    .font(.title2)
                    .bold()
                )
        }
    }

    private func startAnimation(geometry: GeometryProxy) {
        timer = Timer.scheduledTimer(withTimeInterval: 7.0, repeats: true) { _ in
            DispatchQueue.main.async {
                withAnimation(Animation.linear(duration: 2.0)) {
                    animate.toggle()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    animate.toggle()
                }
            }
        }
    }
}
