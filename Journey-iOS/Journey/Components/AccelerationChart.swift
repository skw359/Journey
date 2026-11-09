// Chart of acceleration over a journey.

import SwiftUI

struct AccelerationChart: View, Equatable {
    let distancesMi: [Double]
    let speedsMph: [Double]
    let timesMs: [Double]
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.distancesMi == rhs.distancesMi && lhs.speedsMph == rhs.speedsMph && lhs.timesMs == rhs.timesMs
    }

    private var content: ProfileChartContent {
        let samples = ProfileSeries.acceleration(distancesMi: distancesMi, speedsMph: speedsMph, timesMs: timesMs, useMetric: useMetricUnits)
        let unit = JourneyUnits.accelerationUnit(useMetric: useMetricUnits)
        let spokenUnit = useMetricUnits ? "meters per second squared" : "feet per second squared"
        let values = samples.map(\.y)
        let hardestAcceleration = max(values.max() ?? 0, 0)
        let hardestBraking = min(values.min() ?? 0, 0)
        let format = { ProfileChartFormat.signed($0, decimals: 1) }

        return ProfileChartContent(
            kind: .acceleration,
            samples: samples,
            yStyle: .symmetric(minimumMagnitude: useMetricUnits ? 0.5 : 1),
            xAxis: ProfileChartContent.xAxis(distancesMi: distancesMi, useMetric: useMetricUnits),
            xUnit: JourneyUnits.distanceUnit(useMetric: useMetricUnits),
            spokenXUnit: useMetricUnits ? "kilometers" : "miles",
            yUnit: unit,
            spokenYUnit: spokenUnit,
            headline: ProfileStat(
                label: "Peak acceleration",
                value: format(hardestAcceleration),
                unit: unit,
                spokenValue: "\(format(hardestAcceleration)) \(spokenUnit)"
            ),
            secondary: ProfileStat(
                label: "Peak braking",
                value: format(hardestBraking),
                unit: unit,
                spokenValue: "\(format(hardestBraking)) \(spokenUnit)"
            ),
            signedYAxis: true,
            formatValue: format,
            describeValue: { Self.describe($0) }
        )
    }

    private static func describe(_ value: Double) -> String {
        switch ProfileChartFormat.signed(value, decimals: 1).first {
        case "+": "Speeding up"
        case "\u{2212}": "Slowing"
        default: "Steady"
        }
    }

    var body: some View {
        ProfileChartCard(content: content)
    }
}
