import SwiftUI

struct TravelModeIcon: View {
    let mode: String?

    var body: some View {
        Image(systemName: iconName)
            .font(.system(size: 20))
            .foregroundColor(AppConstants.journeyGreen)
            .frame(width: 44, height: 44)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(AppConstants.journeyGreen.opacity(0.15))
            )
    }

    private var iconName: String {
        switch mode {
        case "foot": return "figure.walk"
        case "scooter": return "scooter"
        case "drive": return "car.fill"
        default: return "figure.walk"
        }
    }
}
