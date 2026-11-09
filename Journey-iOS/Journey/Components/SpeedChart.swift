// Chart of speed over a journey.

import SwiftUI

struct SpeedChart: View, Equatable {
    let distancesMi: [Double]
    let speedsMph: [Double]
    let timesMs: [Double]
    let topSpeedMph: Double?
    let averageSpeedMph: Double?
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.distancesMi == rhs.distancesMi && lhs.speedsMph == rhs.speedsMph && lhs.timesMs == rhs.timesMs
            && lhs.topSpeedMph == rhs.topSpeedMph && lhs.averageSpeedMph == rhs.averageSpeedMph
    }

    private var content: ProfileChartContent {
        let samples = ProfileSeries.speed(distancesMi: distancesMi, speedsMph: speedsMph, timesMs: timesMs, useMetric: useMetricUnits)
        let unit = JourneyUnits.speedUnit(useMetric: useMetricUnits)
        let spokenUnit = useMetricUnits ? "kilometers per hour" : "miles per hour"
        let convert = { JourneyUnits.speed(fromMph: $0, useMetric: useMetricUnits) }

        let top = [topSpeedMph.map(convert), samples.map(\.y).max()].compactMap { $0 }.max() ?? 0
        let average = averageSpeedMph.flatMap { $0 > 0 ? convert($0) : nil }

        return ProfileChartContent(
            kind: .speed,
            samples: samples,
            yStyle: .fromZero(minimumTop: 5),
            xAxis: ProfileChartContent.xAxis(distancesMi: distancesMi, useMetric: useMetricUnits),
            xUnit: JourneyUnits.distanceUnit(useMetric: useMetricUnits),
            spokenXUnit: useMetricUnits ? "kilometers" : "miles",
            yUnit: unit,
            spokenYUnit: spokenUnit,
            headline: ProfileStat(
                label: "Top speed",
                value: ProfileChartFormat.whole(top),
                unit: unit,
                spokenValue: "\(ProfileChartFormat.whole(top)) \(spokenUnit)"
            ),
            secondary: average.map {
                ProfileStat(
                    label: "Average",
                    value: ProfileChartFormat.whole($0),
                    unit: unit,
                    spokenValue: "\(ProfileChartFormat.whole($0)) \(spokenUnit)",
                    isReferenceLine: true
                )
            },
            referenceLine: average,
            formatValue: { ProfileChartFormat.number($0, decimals: 1) }
        )
    }

    var body: some View {
        ProfileChartCard(content: content)
    }
}
