// Mini recording bar shown on the tab bar while recording.

import SwiftUI

struct RecordingAccessory: View {
    @Environment(LocationService.self) private var locationService
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "circle.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(AppConstants.journeyGreen)
                    .symbolEffect(.pulse, options: .repeating)

                Text("Recording")
                    .font(.montserrat(size: 13, weight: .semibold))
                    .lineLimit(1)

                Spacer(minLength: 0)

                Text(DurationFormatter.format(locationService.totalSeconds))
                    .font(.montserrat(size: 14, weight: .bold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .contentTransition(.numericText())
                    .animation(.default, value: locationService.totalSeconds)

                Text("\(DistanceFormatter.format(locationService.distanceMiles, useMetric: useMetricUnits)) \(DistanceFormatter.unit(useMetric: useMetricUnits))")
                    .font(.montserrat(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.75))
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityLabel("Recording in progress")
        .accessibilityValue(DurationFormatter.format(locationService.totalSeconds))
        .accessibilityHint("Shows the recording map")
    }
}
