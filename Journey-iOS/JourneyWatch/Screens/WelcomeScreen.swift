// First-launch welcome screen.

import SwiftUI

struct WelcomeScreen: View {
    private static let features = [
        "Real-time tracking of distance, speed, elevation, and more.",
        "Built-in compass, waypoints, and smart high altitude alerts to keep you safe.",
        "Location awareness with live area details.",
        "Set target speeds and get alerted when you hit your marks.",
        "No phone required.*"
    ]

    let onStart: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Welcome to Journey.")
                    .font(.title3.bold())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .frame(maxWidth: .infinity)

                Text("The travel companion so good that adventure becomes second nature.")
                    .font(.headline)

                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Self.features, id: \.self) { feature in
                        HStack(alignment: .top) {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.caption)
                            Text(feature).font(.subheadline)
                        }
                    }
                }
                .padding(10)
                .background(.white.opacity(0.1), in: .rect(cornerRadius: 10))

                Text("TLDR: Active outdoor tracking and navigation tailored for adventurers.")
                    .font(.caption)

                Button("Start", action: onStart)
                    .buttonStyle(.wide(.white))
                    .foregroundStyle(.black)
            }
            .padding(.horizontal, 8)
        }
        .background(Color(hex: 0x1E4C40).ignoresSafeArea())
    }
}
