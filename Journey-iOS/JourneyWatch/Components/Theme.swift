// Colors, button styles and shared title views.

import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xFF) / 255,
                  green: Double(hex >> 8 & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

enum Theme {
    static let accent = Color(hex: 0x00FF81)
    static let caption = Color(hex: 0x05DF73)
    static let place = Color(hex: 0xBEE0EC)
    static let dim = Color(hex: 0x8A8A8E)
    static let primaryButton = Color(hex: 0x0C3617)
    static let secondaryButton = Color(hex: 0x222223)
    static let aligned = Color(hex: 0x34C759)
}

struct WideButtonStyle: ButtonStyle {
    let background: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .padding(.horizontal, 8)
            .background(background, in: .rect(cornerRadius: 15))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension ButtonStyle where Self == WideButtonStyle {
    static func wide(_ background: Color = Theme.secondaryButton) -> Self {
        WideButtonStyle(background: background)
    }
}

struct IconTitle: View {
    let title: String
    let symbol: String
    var tint = Color.white

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(title)
        }
    }
}
