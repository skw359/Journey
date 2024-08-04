import SwiftUI

struct Shine: View {
    var iconName: String?
    var text: String
    var baseColor: Color
    var shimmerColor: Color = .white
    @State private var gradientPosition: CGFloat = -1
    
    var body: some View {
        ZStack {
            HStack(spacing: 8) {
                if let iconName = iconName {
                    Image(systemName: iconName)
                        .font(.headline)
                }
                Text(text)
                    .font(.headline)
                    .fontWeight(.bold)
            }
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
                            Animation.linear(duration: 2.0)
                                .repeatForever(autoreverses: false)
                        ) {
                            gradientPosition = 1
                        }
                    }
                }
            )
            .mask(
                HStack(spacing: 8) {
                    if let iconName = iconName {
                        Image(systemName: iconName)
                            .font(.headline)
                    }
                    Text(text)
                        .font(.headline)
                        .fontWeight(.bold)
                }
            )
        }
    }
}

struct Shine2: View {
    var iconName: String?
    var text: String
    var baseColor: Color
    var shimmerColor: Color = .white
    @State private var gradientPosition: CGFloat = -1
    
    var body: some View {
        ZStack {
            HStack(spacing: 8) {
                if let iconName = iconName {
                    Image(systemName: iconName)
                        .font(.headline)
                }
                Text(text)
                    .font(.headline)
                 
            }
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
                            Animation.linear(duration: 2.0)
                                .repeatForever(autoreverses: false)
                        ) {
                            gradientPosition = 1
                        }
                    }
                }
            )
            .mask(
                HStack(spacing: 8) {
                    if let iconName = iconName {
                        Image(systemName: iconName)
                            .font(.headline)
                    }
                    Text(text)
                        .font(.headline)
                 
                }
            )
        }
    }
}
