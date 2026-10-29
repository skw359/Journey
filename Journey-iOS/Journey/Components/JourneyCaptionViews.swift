import SwiftUI

/// Green travel-mode pill ("WALK", "DRIVE", …) shown on journey heroes and cards.
struct JourneyCategoryPill: View {
    let travelMode: String?
    var fontSize: CGFloat = 11

    var body: some View {
        Text(Self.label(for: travelMode))
            .font(.montserrat(size: fontSize, weight: .semibold))
            .tracking(1.2)
            .foregroundStyle(.black)
            .padding(.horizontal, fontSize * 0.9)
            .padding(.vertical, fontSize * 0.45)
            .background(Capsule().fill(AppConstants.journeyGreen))
    }

    static func label(for travelMode: String?) -> String {
        switch travelMode {
        case "foot": "WALK"
        case "scooter": "SCOOTER"
        case "drive": "DRIVE"
        case "flight": "FLIGHT"
        default: "JOURNEY"
        }
    }
}

/// Location, distance and duration with small icons, shown under journey titles.
struct JourneyMetadataRow: View {
    let summary: JourneySummary
    var fontSize: CGFloat = 12

    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    var body: some View {
        HStack(spacing: fontSize * 1.3) {
            if let locationText {
                item(icon: "mappin", text: locationText)
            }
            item(
                icon: "point.topleft.down.to.point.bottomright.curvepath",
                text: "\(DistanceFormatter.format(summary.distanceDouble, useMetric: useMetricUnits)) \(DistanceFormatter.unit(useMetric: useMetricUnits))"
            )
            .layoutPriority(1)
            if summary.duration != nil {
                item(icon: "clock", text: DurationFormatter.formatReadable(compact: summary.duration))
                    .layoutPriority(1)
            }
        }
        .foregroundStyle(.white.opacity(0.82))
    }

    /// First and last city passed, e.g. "San Jose → Palo Alto"
    private var locationText: String? {
        let cities = (summary.citiesPassed ?? []).filter { !$0.isEmpty }
        guard let first = cities.first else { return nil }
        guard let last = cities.last, last != first else { return first }
        return "\(first) \u{2192} \(last)"
    }

    private func item(icon: String, text: String) -> some View {
        HStack(spacing: fontSize * 0.4) {
            Image(systemName: icon)
                .font(.system(size: fontSize - 1, weight: .medium))
            Text(text)
                .font(.montserrat(size: fontSize))
                .lineLimit(1)
        }
    }
}
