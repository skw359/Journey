import SwiftUI

struct FloatingStatsCard: View {
    enum Detent {
        case collapsed
        case expanded
    }

    let collapsedHeight: CGFloat
    let expandedHeight: CGFloat
    let totalSeconds: Int
    let distanceMiles: Double
    let currentSpeedMph: Double
    let averageSpeedMph: Double
    let topSpeedMph: Double
    let pointCount: Int
    let useMetric: Bool
    let roadLabel: String
    let isRecording: Bool

    @State private var detent: Detent = .collapsed
    @GestureState private var dragTranslation: CGFloat = 0

    private var resolvedHeight: CGFloat {
        let base = detent == .collapsed ? collapsedHeight : expandedHeight
        let proposed = base - dragTranslation
        let upperBound = expandedHeight + 24
        return min(max(proposed, collapsedHeight - 12), upperBound)
    }

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.white.opacity(0.28))
                .frame(width: 38, height: 5)
                .padding(.top, 10)
                .padding(.bottom, 10)

            if !roadLabel.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "location.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(AppConstants.journeyGreen)
                    Text(roadLabel)
                        .font(.montserrat(size: 12, weight: .semibold))
                        .foregroundColor(.white.opacity(0.85))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .padding(.bottom, 8)
                .transition(.opacity)
            }

            HStack(alignment: .top, spacing: 8) {
                statColumn(
                    label: "TIME",
                    value: DurationFormatter.format(totalSeconds),
                    unit: "",
                    valueSize: 24
                )

                statColumn(
                    label: "DISTANCE",
                    value: DistanceFormatter.format(distanceMiles, useMetric: useMetric),
                    unit: DistanceFormatter.unit(useMetric: useMetric),
                    valueSize: 24
                )

                statColumn(
                    label: "SPEED",
                    value: String(format: "%.1f", JourneyUnits.speed(fromMph: currentSpeedMph, useMetric: useMetric)),
                    unit: JourneyUnits.speedUnit(useMetric: useMetric),
                    valueSize: 24
                )
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .animation(.spring(response: 0.5, dampingFraction: 0.85), value: totalSeconds)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .frame(height: resolvedHeight, alignment: .top)
        .overlay(alignment: .top) {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(Color.white.opacity(0.08))
                    .frame(height: 1)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)

                HStack(spacing: 0) {
                    statColumn(
                        label: "AVG",
                        value: String(format: "%.1f", JourneyUnits.speed(fromMph: averageSpeedMph, useMetric: useMetric)),
                        unit: JourneyUnits.speedUnit(useMetric: useMetric),
                        valueSize: 22
                    )

                    verticalDivider

                    statColumn(
                        label: "TOP",
                        value: String(format: "%.1f", JourneyUnits.speed(fromMph: topSpeedMph, useMetric: useMetric)),
                        unit: JourneyUnits.speedUnit(useMetric: useMetric),
                        valueSize: 22
                    )

                    verticalDivider

                    statColumn(
                        label: "POINTS",
                        value: "\(pointCount)",
                        unit: "",
                        valueSize: 22
                    )
                }
                .padding(.horizontal, 20)
            }
            .padding(.top, collapsedHeight)
        }
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: Color.black.opacity(0.35), radius: 24, x: 0, y: 10)
        .contentShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .gesture(
            DragGesture(minimumDistance: 4)
                .updating($dragTranslation) { value, state, _ in
                    state = value.translation.height
                }
                .onEnded { value in
                    let translation = value.translation.height
                    let predicted = value.predictedEndTranslation.height
                    let velocity = predicted - translation

                    withAnimation(.spring(response: 0.42, dampingFraction: 0.82)) {
                        switch detent {
                        case .collapsed:
                            if translation < -40 || velocity < -250 {
                                detent = .expanded
                            }
                        case .expanded:
                            if translation > 40 || velocity > 250 {
                                detent = .collapsed
                            }
                        }
                    }
                }
        )
        .animation(.spring(response: 0.42, dampingFraction: 0.82), value: dragTranslation)
        .animation(.spring(response: 0.5, dampingFraction: 0.78), value: detent)
    }

    private var verticalDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.1))
            .frame(width: 1, height: 34)
    }

    private func statColumn(label: String, value: String, unit: String, valueSize: CGFloat = 28) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.montserrat(size: 10, weight: .semibold))
                .foregroundColor(AppConstants.secondaryText)
                .tracking(1.1)

            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.montserrat(size: valueSize, weight: .bold))
                    .foregroundColor(.white)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)

                if !unit.isEmpty {
                    Text(unit)
                        .font(.montserrat(size: 11, weight: .semibold))
                        .foregroundColor(AppConstants.journeyGreen)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}
