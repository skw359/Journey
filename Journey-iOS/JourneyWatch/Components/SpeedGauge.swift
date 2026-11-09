// Ring gauge showing speed against the target.

import SwiftUI

struct SpeedGauge: View {
    private static let sweep = 0.75

    let speed: Double
    let target: Int

    private var progress: Double { min(max(speed, 0) / Double(target), 1) }

    var body: some View {
        GeometryReader { geometry in
            let side = min(geometry.size.width, geometry.size.height)
            ZStack {
                Circle()
                    .trim(from: 0, to: Self.sweep)
                    .stroke(.white.opacity(0.18), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(135))
                Circle()
                    .trim(from: 0, to: Self.sweep * progress)
                    .stroke(Theme.accent, lineWidth: 5)
                    .rotationEffect(.degrees(135))
                Capsule()
                    .fill(Theme.accent)
                    .frame(width: 3, height: side / 2)
                    .offset(y: -side / 4)
                    .rotationEffect(.degrees(-135 + 270 * progress))
                Circle()
                    .fill(Theme.aligned)
                    .frame(width: 8, height: 8)
                Text("mph")
                    .font(.system(size: side * 0.09))
                    .offset(y: side * 0.25)
                Text("\(Int(max(speed, 0)))")
                    .font(.system(size: side * 0.24, weight: .bold))
                    .offset(y: side * 0.41)
            }
            .frame(width: side, height: side)
            .frame(maxWidth: .infinity)
            .animation(.spring(response: 0.9, dampingFraction: 0.7), value: progress)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
