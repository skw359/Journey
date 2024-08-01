import Foundation
import SwiftUI

struct ShimmeringText: View {
    var text: String
    @State private var gradientPosition: CGFloat = -1
    
    var body: some View {
        ZStack {
            Text(text)
                .foregroundColor(.white)
                .background(
                    GeometryReader { geometry in
                        LinearGradient(
                            gradient: Gradient(colors: [Color.white.opacity(0), Color.white, Color.white.opacity(0)]),
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
