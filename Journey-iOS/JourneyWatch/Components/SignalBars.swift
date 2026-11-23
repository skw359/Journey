// GPS signal strength bars.

import CoreLocation
import SwiftUI

struct SignalBars: View {
    private static let barCount = 4
    private static let sweepStep: TimeInterval = 0.2
    private static let fadeIn = Animation.easeOut(duration: 0.12)
    private static let fadeOut = Animation.easeOut(duration: 0.5)

    let accuracy: CLLocationAccuracy?

    static func strength(accuracy: CLLocationAccuracy?) -> Int {
        guard let accuracy, accuracy > 0 else { return 0 }
        switch accuracy * Units.feetPerMeter {
        case ..<50: return 4
        case ..<100: return 3
        case ..<150: return 2
        case ...500: return 1
        default: return 0
        }
    }

    var body: some View {
        let strength = Self.strength(accuracy: accuracy)
        if strength > 0 {
            bars { $0 < strength }
        } else {
            TimelineView(.periodic(from: .now, by: Self.sweepStep)) { context in
                let step = Int(context.date.timeIntervalSinceReferenceDate / Self.sweepStep) % (Self.barCount * 2)
                bars(fades: true) { $0 == step }
            }
        }
    }

    private func bars(fades: Bool = false, isLit: @escaping (Int) -> Bool) -> some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<Self.barCount, id: \.self) { index in
                let lit = isLit(index)
                let shape = RoundedRectangle(cornerRadius: 1.5)
                shape
                    .fill(Color(hex: 0x1C1C24))
                    .overlay {
                        shape
                            .fill(Theme.accent)
                            .opacity(lit ? 1 : 0)
                            .animation(fades ? (lit ? Self.fadeIn : Self.fadeOut) : nil, value: lit)
                    }
                    .frame(width: 5, height: CGFloat(index + 1) * 5)
            }
        }
    }
}
