// Line graph of a reading over the trip.

import SwiftUI

struct TrendGraph: View {
    private static let gridColor = Color(hex: 0x2E2E2E)

    let samples: [Sample]
    let range: ClosedRange<Double>
    let color: Color
    let topLabel: String
    let bottomLabel: String
    var hasMidline = false
    var showsTimes = false

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 4, verticalSpacing: 3) {
            GridRow {
                VStack(alignment: .trailing) {
                    Text(topLabel)
                    Spacer(minLength: 0)
                    Text(bottomLabel)
                }
                Canvas { context, size in
                    draw(in: &context, size: size)
                }
            }
            if showsTimes, let first = samples.first, let last = samples.last {
                GridRow {
                    Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                    HStack {
                        Text(first.time.formatted(date: .omitted, time: .shortened))
                        Spacer(minLength: 0)
                        Text(last.time.formatted(date: .omitted, time: .shortened))
                    }
                }
            }
        }
        .font(.system(size: 10))
        .foregroundStyle(Theme.dim)
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        var grid = Path()
        for fraction in hasMidline ? [0, 0.5, 1] : [0, 1] {
            grid.move(to: CGPoint(x: 0, y: size.height * fraction))
            grid.addLine(to: CGPoint(x: size.width, y: size.height * fraction))
        }
        context.stroke(grid, with: .color(Self.gridColor))

        guard let first = samples.first, let last = samples.last else { return }
        let duration = max(last.time.timeIntervalSince(first.time), 1)
        let span = range.upperBound - range.lowerBound
        var line = Path()
        line.addLines(samples.map { sample in
            let height = span > 0 ? (sample.value - range.lowerBound) / span : 0.5
            return CGPoint(x: size.width * sample.time.timeIntervalSince(first.time) / duration,
                           y: size.height * (1 - height))
        })
        context.stroke(line, with: .color(color), lineWidth: 2)
    }
}
