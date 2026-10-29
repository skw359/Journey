import SwiftUI

struct DurationCounter: View {
    let totalSeconds: Int

    var body: some View {
        VStack(spacing: 4) {
            Text("Time Elapsed")
                .font(.montserrat(size: 13, weight: .semibold))
                .foregroundColor(.gray)
                .tracking(1)

            Text(DurationFormatter.format(totalSeconds))
                .font(.montserrat(size: 52, weight: .bold))
                .foregroundColor(.white)
                .monospacedDigit()
                .contentTransition(.numericText())
                .animation(.default, value: totalSeconds)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
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
