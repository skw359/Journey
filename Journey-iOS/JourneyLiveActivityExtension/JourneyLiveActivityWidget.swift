import ActivityKit
import WidgetKit
import SwiftUI

struct JourneyLiveActivityWidget: Widget {
    private let accent = Color(red: 0, green: 214 / 255, blue: 126 / 255)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: JourneyLiveActivityAttributes.self) { context in
            lockScreenContent(for: context)
                .padding(18)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(accent)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    expandedMetric(
                        title: "DISTANCE",
                        value: formattedDistance(context.state.distanceMiles)
                    )
                }
                DynamicIslandExpandedRegion(.trailing) {
                    expandedMetric(
                        title: "SPEED",
                        value: "\(Int(context.state.speedMph.rounded())) mph"
                    )
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 4) {
                        HStack(spacing: 6) {
                            Image(systemName: "record.circle.fill")
                                .foregroundStyle(accent)
                            Text("Recording")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        Text(timerInterval: context.state.startedAt...Date(), countsDown: false)
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .monospacedDigit()
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 10) {
                        Text(context.state.statusText)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.white.opacity(0.9))
                            .lineLimit(1)
                        Spacer()
                        Text("\(context.state.pointCount) pts")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(accent)
                    }
                }
            } compactLeading: {
                Image(systemName: "record.circle.fill")
                    .foregroundStyle(accent)
            } compactTrailing: {
                Text(compactDistance(context.state.distanceMiles))
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .monospacedDigit()
            } minimal: {
                Image(systemName: "record.circle.fill")
                    .foregroundStyle(accent)
            }
            .keylineTint(accent)
        }
    }

    @ViewBuilder
    private func lockScreenContent(
        for context: ActivityViewContext<JourneyLiveActivityAttributes>
    ) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Journey")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(accent)
                    Text(context.state.statusText)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white.opacity(0.85))
                }
                Spacer()
                Text(timerInterval: context.state.startedAt...Date(), countsDown: false)
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .monospacedDigit()
            }

            HStack(spacing: 12) {
                lockMetric(title: "Distance", value: formattedDistance(context.state.distanceMiles))
                lockMetric(title: "Speed", value: "\(Int(context.state.speedMph.rounded())) mph")
                lockMetric(title: "Points", value: "\(context.state.pointCount)")
            }
        }
    }

    @ViewBuilder
    private func lockMetric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(accent)
            Text(value)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.08))
        )
    }

    @ViewBuilder
    private func expandedMetric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(accent)
            Text(value)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }

    private func formattedDistance(_ miles: Double) -> String {
        switch miles {
        case 1000...:
            return miles.formatted(.number.precision(.fractionLength(0)))
        case 10...:
            return miles.formatted(.number.precision(.fractionLength(1)))
        default:
            return miles.formatted(.number.precision(.fractionLength(2)))
        }
    }

    private func compactDistance(_ miles: Double) -> String {
        if miles >= 100 {
            return "\(Int(miles.rounded()))m"
        }
        if miles >= 10 {
            return miles.formatted(.number.precision(.fractionLength(1))) + "m"
        }
        return miles.formatted(.number.precision(.fractionLength(2))) + "m"
    }
}
