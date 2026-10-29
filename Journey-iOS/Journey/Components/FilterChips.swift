import SwiftUI

enum JourneyFilter: String, CaseIterable {
    case all = "All Activities"
    case past7Days = "Past 7 Days"
    case distanceOver5 = "Distance > 5mi"
}

struct FilterChips: View {
    @Binding var selected: JourneyFilter

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(JourneyFilter.allCases, id: \.self) { filter in
                    Button {
                        selected = filter
                    } label: {
                        Text(filter.rawValue)
                            .font(.montserrat(size: 13, weight: .semibold))
                            .foregroundColor(selected == filter ? .black : .white.opacity(0.7))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(
                                Capsule()
                                    .fill(selected == filter ? AppConstants.journeyGreen : Color.white.opacity(0.08))
                            )
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }
}
