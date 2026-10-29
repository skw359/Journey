import SwiftUI

struct JourneyRowView: View {
    let journey: JourneySummary
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    var body: some View {
        HStack(spacing: 12) {
            TravelModeIcon(mode: journey.travelMode)

            VStack(alignment: .leading, spacing: 3) {
                Text(journey.displayName)
                    .font(.montserrat(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)

                Text(journey.subtitleString)
                    .font(.montserrat(size: 13))
                    .foregroundColor(.gray)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 3) {
                Text("\(DistanceFormatter.format(journey.distanceDouble, useMetric: useMetricUnits)) \(DistanceFormatter.unit(useMetric: useMetricUnits))")
                    .font(.montserrat(size: 15, weight: .bold))
                    .foregroundColor(AppConstants.journeyGreen)

                Text("\(Int(JourneyUnits.speed(fromMph: journey.avgSpeedDouble, useMetric: useMetricUnits).rounded())) \(JourneyUnits.speedUnit(useMetric: useMetricUnits))")
                    .font(.montserrat(size: 13))
                    .foregroundColor(.gray)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(AppConstants.darkCardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(AppConstants.darkCardBorder, lineWidth: 1)
                )
        )
    }
}
