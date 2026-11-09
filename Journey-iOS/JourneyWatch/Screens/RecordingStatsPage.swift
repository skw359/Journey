// Live stats page shown while recording.

import SwiftUI

struct RecordingStatsPage: View {
    let recorder: JourneyRecorder
    @AppStorage("usePreciseUnits") private var usePreciseUnits = false
    @State private var showsCounty = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                SignalBars(accuracy: recorder.accuracy)
                    .padding(.top, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                PulsingDot()
            }

            placeName

            Spacer(minLength: 0)

            VStack(spacing: -2) {
                bigStat(Format.miles(recorder.distance, precise: usePreciseUnits), unit: "MILES")
                bigStat(Format.speed(recorder.speed, precise: usePreciseUnits), unit: "MPH")
            }

            Spacer(minLength: 0)

            HStack(alignment: .bottom) {
                smallStat(Text(Format.elevation(recorder.elevation)), label: "Elevation", alignment: .leading)
                Spacer(minLength: 4)
                TimelineView(.periodic(from: recorder.startDate, by: 1)) { context in
                    smallStat(Text(Format.clock(recorder.activeTime(at: context.date))).monospacedDigit(),
                              label: "Total Time", alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .ignoresSafeArea()
        .pauseOverlay(recorder.isPaused)
    }

    private var placeName: some View {
        let county = recorder.place.county
        return Text(showsCounty && !county.isEmpty ? county : recorder.place.name)
            .font(.system(size: 13))
            .foregroundStyle(Theme.place)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity, minHeight: 16)
            .contentShape(.rect)
            .onTapGesture {
                if !county.isEmpty { showsCounty.toggle() }
            }
    }

    private func bigStat(_ value: String, unit: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(value)
                .font(.system(size: 43, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            Text(unit)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.caption)
        }
    }

    private func smallStat(_ value: Text, label: String, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 0) {
            value
                .font(.system(size: 21))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.caption)
        }
    }
}

private struct PulsingDot: View {
    var body: some View {
        Circle()
            .fill(Theme.accent)
            .frame(width: 12, height: 12)
            .phaseAnimator([1, 0.3]) { dot, opacity in
                dot.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 1)
            }
    }
}
