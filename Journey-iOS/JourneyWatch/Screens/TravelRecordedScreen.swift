// Summary shown after a trip.

import SwiftUI

struct TravelRecordedScreen: View {
    let trip: Trip
    @Environment(\.dismiss) private var dismiss

    private var timeFontSize: CGFloat {
        switch trip.duration {
        case ..<3600: 25
        case ..<36000: 20
        default: 15
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                stat(Format.whole(trip.miles), label: "Miles Traveled", size: 57)

                Grid(horizontalSpacing: 8, verticalSpacing: 12) {
                    GridRow {
                        stat(Format.whole(trip.topSpeed), label: "Top Speed", size: 30)
                        stat(Format.whole(trip.averageSpeed), label: "AVG Speed", size: 30)
                    }
                    GridRow {
                        stat(Format.clock(trip.duration), label: "Total Time", size: timeFontSize)
                        Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                    }
                }

                elevationRange
                speedGraph
                elevationGraph

                Button("Done") { dismiss() }
                    .buttonStyle(.wide(Theme.primaryButton))
            }
            .padding(.horizontal, 8)
        }
        .navigationBarBackButtonHidden()
    }

    private func stat(_ value: String, label: String, size: CGFloat) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: size))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.accent)
        }
        .frame(maxWidth: .infinity)
    }

    private var elevationRange: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Elevation").font(.headline)
            elevationRow(trip.highElevation, isHigh: true)
            elevationRow(trip.lowElevation, isHigh: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func elevationRow(_ meters: Double?, isHigh: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Theme.accent)
                .rotationEffect(.degrees(isHigh ? 0 : 180))
            Text(Format.elevation(meters)).font(.system(size: 14))
        }
    }

    private var speedGraph: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Speed Over Time").font(.headline)
            TrendGraph(samples: trip.speedSamples,
                       range: 0...max(trip.speedSamples.map(\.value).max() ?? 0, trip.topSpeed),
                       color: Color(hex: 0xFF9500),
                       topLabel: Format.whole(trip.topSpeed),
                       bottomLabel: "0",
                       showsTimes: true)
                .frame(height: 92)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var elevationGraph: some View {
        let low = (trip.lowElevation ?? 0) * Units.feetPerMeter
        let high = (trip.highElevation ?? 0) * Units.feetPerMeter
        return VStack(alignment: .leading, spacing: 6) {
            Text("Elevation").font(.headline)
            TrendGraph(samples: trip.elevationSamples.map { Sample(time: $0.time, value: $0.value * Units.feetPerMeter) },
                       range: low...high,
                       color: Theme.accent,
                       topLabel: trip.highElevation == nil ? "" : Format.whole(high),
                       bottomLabel: trip.lowElevation == nil ? "" : Format.whole(low),
                       hasMidline: true)
                .frame(height: 60)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
