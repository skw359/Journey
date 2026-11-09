// Chart of elevation over a journey.

import SwiftUI

struct ElevationChart: View, Equatable {
    let distancesMi: [Double]
    let elevationsM: [Double?]
    let timesMs: [Double]
    let topElevationM: Double?
    let lowestElevationM: Double?
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.distancesMi == rhs.distancesMi && lhs.elevationsM == rhs.elevationsM && lhs.timesMs == rhs.timesMs
            && lhs.topElevationM == rhs.topElevationM && lhs.lowestElevationM == rhs.lowestElevationM
    }

    private var content: ProfileChartContent {
        let samples = ProfileSeries.elevation(distancesMi: distancesMi, elevationsM: elevationsM, timesMs: timesMs, useMetric: useMetricUnits)
        let unit = JourneyUnits.elevationUnit(useMetric: useMetricUnits)
        let spokenUnit = useMetricUnits ? "meters" : "feet"
        let convert = { JourneyUnits.elevation(fromMeters: $0, useMetric: useMetricUnits) }

        let plotted = samples.map(\.y)
        let highest = [topElevationM.map(convert), plotted.max()].compactMap { $0 }.max() ?? 0
        let lowest = [lowestElevationM.map(convert), plotted.min()].compactMap { $0 }.min() ?? 0

        return ProfileChartContent(
            kind: .elevation,
            samples: samples,
            yStyle: .fitted(minimumSpan: useMetricUnits ? 20 : 50),
            xAxis: ProfileChartContent.xAxis(distancesMi: distancesMi, useMetric: useMetricUnits),
            xUnit: JourneyUnits.distanceUnit(useMetric: useMetricUnits),
            spokenXUnit: useMetricUnits ? "kilometers" : "miles",
            yUnit: unit,
            spokenYUnit: spokenUnit,
            headline: ProfileStat(
                label: "Highest point",
                value: ProfileChartFormat.whole(highest),
                unit: unit,
                spokenValue: "\(ProfileChartFormat.whole(highest)) \(spokenUnit)"
            ),
            secondary: ProfileStat(
                label: "Lowest",
                value: ProfileChartFormat.whole(lowest),
                unit: unit,
                spokenValue: "\(ProfileChartFormat.whole(lowest)) \(spokenUnit)"
            ),
            formatValue: { ProfileChartFormat.whole($0) }
        )
    }

    var body: some View {
        ProfileChartCard(content: content)
    }
}
