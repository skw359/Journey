import SwiftUI

struct StatCard: View {
    let label: String
    let value: String
    let unit: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.montserrat(size: 12, weight: .semibold))
                .foregroundColor(.gray)
                .tracking(1)

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(.montserrat(size: 32, weight: .bold))
                    .foregroundColor(.white)
                    .monospacedDigit()
                    .contentTransition(.numericText())

                Text(unit)
                    .font(.montserrat(size: 14, weight: .semibold))
                    .foregroundColor(AppConstants.journeyGreen)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(AppConstants.darkCardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(AppConstants.darkCardBorder, lineWidth: 1)
                )
        )
    }
}
