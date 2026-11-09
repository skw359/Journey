// Shared overlays, loading views and info sheets.

import SwiftUI

extension View {
    func pauseOverlay(_ isPaused: Bool) -> some View {
        overlay {
            if isPaused {
                ZStack {
                    Color.black.opacity(0.95)
                    VStack(spacing: 12) {
                        Image(systemName: "pause.circle.fill").font(.system(size: 42))
                        Text("Journey Paused").font(.system(size: 16, weight: .bold))
                    }
                }
                .ignoresSafeArea()
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.35), value: isPaused)
    }

    func shimmering() -> some View {
        modifier(Shimmer())
    }
}

private struct Shimmer: ViewModifier {
    @State private var position = -1.0

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geometry in
                    LinearGradient(colors: [.clear, .white, .clear], startPoint: .leading, endPoint: .trailing)
                        .offset(x: position * geometry.size.width)
                }
                .mask(content)
            }
            .onAppear {
                withAnimation(.linear(duration: 1.8).repeatForever(autoreverses: false)) { position = 1 }
            }
    }
}

struct ProcessingView: View {
    var body: some View {
        ZStack {
            Color.black
            HStack(spacing: 8) {
                Image(systemName: "clock.fill")
                Text("Processing")
            }
            .font(.system(size: 17, weight: .bold))
        }
        .ignoresSafeArea()
    }
}

struct CreatingWaypointView: View {
    var body: some View {
        IconTitle(title: "Creating waypoint", symbol: "mappin.and.ellipse", tint: Color(hex: 0x545454))
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(Color(hex: 0x545454))
            .shimmering()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.black)
    }
}

struct InfoSheet<Footer: View>: View {
    let title: String
    let paragraphs: [String]
    @ViewBuilder var footer: Footer

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.headline)
                ForEach(paragraphs, id: \.self) { Text($0).foregroundStyle(Theme.dim) }
                footer
            }
            .padding(.horizontal, 8)
        }
    }
}

struct ToolIntro: View {
    let title: String
    let symbol: String
    let actionTitle: String
    let actionSymbol: String
    let onInfo: () -> Void
    let onAction: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: symbol).foregroundStyle(Theme.accent)
                Text(title).bold()
            }
            .font(.title3)

            Button(action: onInfo) {
                IconTitle(title: "What's this?", symbol: "info.circle")
            }
            .buttonStyle(.wide())

            Button(action: onAction) {
                IconTitle(title: actionTitle, symbol: actionSymbol, tint: Theme.accent)
            }
            .buttonStyle(.wide(Theme.primaryButton))
        }
        .padding(.horizontal, 10)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}
