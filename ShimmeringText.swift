import SwiftUI

struct ShimmeringText: View {
    var text: String
    var baseColor: Color
    var shimmerColor: Color = .white
    @State private var gradientPosition: CGFloat = -1
    
    var body: some View {
        ZStack {
            Text(text)
                .foregroundColor(baseColor)
                .overlay(
                    GeometryReader { geometry in
                        LinearGradient(
                            gradient: Gradient(colors: [shimmerColor.opacity(0), shimmerColor, shimmerColor.opacity(0)]),
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .offset(x: gradientPosition * geometry.size.width)
                        .onAppear {
                            withAnimation(
                                Animation.linear(duration: 1.5)
                                    .repeatForever(autoreverses: false)
                            ) {
                                gradientPosition = 1
                            }
                        }
                    }
                )
                .mask(Text(text))
        }
    }
}
