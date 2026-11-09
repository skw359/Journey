// Caption and status pill shown over the live map while recording.

import SwiftUI

struct RecordingCaption: View {
    struct Metrics {
        var totalSeconds = 0
        var distanceMiles = 0.0
        var currentSpeedMph = 0.0
        var averageSpeedMph = 0.0
        var topSpeedMph = 0.0
        var pointCount = 0
        var elevationMeters: Double?
    }

    let phase: RecordingPhase
    let metrics: Metrics
    let place: String
    let hasLocation: Bool
    let isWaitingForGPS: Bool
    let uploadState: FinishedJourney.UploadState?
    let trailingInset: CGFloat
    let hidesBottomRows: Bool

    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var heroSize: CGFloat { verticalSizeClass == .compact ? 52 : 68 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            statusRow

            if phase == .idle {
                idleContent
                    .transition(.opacity.combined(with: .offset(y: 10)))
            } else {
                readout
                    .transition(.opacity.combined(with: .offset(y: 10)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusRow: some View {
        HStack(spacing: 8) {
            if let pillStatus {
                StatusPill(status: pillStatus)
            }

            Group {
                if isWaitingForGPS {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(.white)
                        Text("Waiting for GPS...")
                    }
                } else if !place.isEmpty {
                    Text(place)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .font(.montserrat(size: 11, weight: .medium))
            .foregroundStyle(.white.opacity(0.75))

            Spacer(minLength: 0)
        }
    }

    private var pillStatus: StatusPill.Status? {
        switch phase {
        case .idle:
            return hasLocation ? nil : .locating
        case .recording:
            return .recording
        case .finished:
            switch uploadState ?? .saving {
            case .saving: return .saving
            case .saved: return .saved
            case .notSaved: return .notSaved
            case .failed: return .notUploaded
            }
        }
    }

    private var idleContent: some View {
        idleHeadline
            .font(.montserrat(size: verticalSizeClass == .compact ? 28 : 34, weight: .heavy))
            .foregroundStyle(.white)
            .lineLimit(verticalSizeClass == .compact ? 1 : 2)
            .minimumScaleFactor(0.7)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private var idleHeadline: Text {
        if hasLocation {
            Text("Ready when \(Text("you are.").foregroundStyle(AppConstants.journeyGreen))")
        } else {
            Text("Waiting for \(Text("GPS.").foregroundStyle(AppConstants.journeyGreen))")
        }
    }

    private var readout: some View {
        VStack(alignment: .leading, spacing: 8) {
            heroDistance

            VStack(alignment: .leading, spacing: 8) {
                primaryStats
                secondaryStats
            }
            .padding(.trailing, trailingInset)
            .opacity(hidesBottomRows ? 0 : 1)

            if let uploadNote {
                Text(uploadNote)
                    .font(.montserrat(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.82))
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
    }

    private var heroDistance: some View {
        let value = DistanceFormatter.format(metrics.distanceMiles, useMetric: useMetricUnits)
        let unit = DistanceFormatter.unit(useMetric: useMetricUnits)
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(value)
                .font(.montserrat(size: heroSize, weight: .heavy))
                .tracking(-1)
                .foregroundStyle(.white)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.numericText())
                .animation(.default, value: value)
            Text(unit)
                .font(.montserrat(size: 18, weight: .semibold))
                .foregroundStyle(AppConstants.journeyGreen)
                .fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Distance")
        .accessibilityValue("\(value) \(unit)")
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var primaryStats: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 18) {
                timeStat
                speedStat
            }
            VStack(alignment: .leading, spacing: 4) {
                timeStat
                speedStat
            }
        }
    }

    private var timeStat: some View {
        let value = DurationFormatter.format(metrics.totalSeconds)
        return Text(value)
            .font(.montserrat(size: 26, weight: .bold))
            .foregroundStyle(.white)
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .contentTransition(.numericText())
            .animation(.default, value: value)
            .accessibilityLabel(phase == .finished ? "Total time" : "Elapsed time")
            .accessibilityValue(spokenDuration)
            .accessibilityAddTraits(.updatesFrequently)
    }

    @ViewBuilder
    private var speedStat: some View {
        if phase == .recording {
            stat(
                value: speedValue(metrics.currentSpeedMph),
                unit: JourneyUnits.speedUnit(useMetric: useMetricUnits),
                spokenName: "Speed"
            )
        } else {
            stat(
                value: speedValue(metrics.averageSpeedMph),
                unit: "\(JourneyUnits.speedUnit(useMetric: useMetricUnits)) avg",
                spokenName: "Average speed"
            )
        }
    }

    private var secondaryStats: some View {
        ViewThatFits(in: .horizontal) {
            secondaryRow(withUnits: true)
            secondaryRow(withUnits: false)
            VStack(alignment: .leading, spacing: 4) {
                if phase == .recording {
                    elevationDetail(elevationText)
                }
                detail(label: "TOP", value: speedText(metrics.topSpeedMph))
                detail(label: "POINTS", value: "\(metrics.pointCount)")
            }
        }
    }

    private func secondaryRow(withUnits: Bool) -> some View {
        HStack(spacing: 14) {
            if phase == .recording {
                elevationDetail(withUnits ? elevationText : elevationValue)
            }
            detail(label: "TOP", value: withUnits ? speedText(metrics.topSpeedMph) : speedValue(metrics.topSpeedMph))
            detail(label: "POINTS", value: "\(metrics.pointCount)")
        }
    }

    private var uploadNote: String? {
        switch uploadState {
        case .notSaved:
            return "The server didn't add this one to your journeys."
        case .failed:
            return "It's safe on this iPhone. You can retry from Uploads in Settings."
        default:
            return nil
        }
    }

    private func stat(value: String, unit: String, spokenName: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value)
                .font(.montserrat(size: 26, weight: .bold))
                .foregroundStyle(.white)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.numericText())
                .animation(.default, value: value)
            Text(unit)
                .font(.montserrat(size: 12, weight: .semibold))
                .foregroundStyle(AppConstants.journeyGreen)
                .fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenName)
        .accessibilityValue("\(value) \(unit)")
    }

    private func detail(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(label)
                .font(.montserrat(size: 10, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(.white.opacity(0.5))
            Text(value)
                .font(.montserrat(size: 12))
                .foregroundStyle(.white.opacity(0.82))
                .monospacedDigit()
        }
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
    }

    private func elevationDetail(_ value: String) -> some View {
        detail(label: "ELEV", value: value)
            .accessibilityLabel("Elevation")
            .accessibilityValue(value)
    }

    private var elevationValue: String {
        guard let meters = metrics.elevationMeters else { return "\u{2014}" }
        return Int(JourneyUnits.elevation(fromMeters: meters, useMetric: useMetricUnits).rounded()).formatted()
    }

    private var elevationText: String {
        guard metrics.elevationMeters != nil else { return elevationValue }
        return "\(elevationValue) \(JourneyUnits.elevationUnit(useMetric: useMetricUnits))"
    }

    private func speedValue(_ mph: Double) -> String {
        String(format: "%.1f", JourneyUnits.speed(fromMph: mph, useMetric: useMetricUnits))
    }

    private func speedText(_ mph: Double) -> String {
        "\(speedValue(mph)) \(JourneyUnits.speedUnit(useMetric: useMetricUnits))"
    }

    private var spokenDuration: String {
        Duration.seconds(metrics.totalSeconds)
            .formatted(.units(allowed: [.hours, .minutes, .seconds], width: .wide))
    }
}

struct StatusPill: View {
    enum Status {
        case locating, recording, saving, saved, notSaved, notUploaded, connected, notConnected

        var title: String {
            switch self {
            case .locating: "LOCATING"
            case .recording: "RECORDING"
            case .saving: "SAVING"
            case .saved: "SAVED"
            case .notSaved: "NOT SAVED"
            case .notUploaded: "NOT UPLOADED"
            case .connected: "CONNECTED"
            case .notConnected: "NOT CONNECTED"
            }
        }

        var background: Color {
            switch self {
            case .locating, .saving, .notSaved: .white.opacity(0.16)
            case .recording, .saved, .connected: AppConstants.journeyGreen
            case .notUploaded: AppConstants.redAction
            case .notConnected: .yellow
            }
        }

        var foreground: Color {
            switch self {
            case .recording, .saved, .connected, .notConnected: .black
            default: .white
            }
        }
    }

    let status: Status

    private let fontSize: CGFloat = 11

    var body: some View {
        HStack(spacing: 5) {
            switch status {
            case .recording:
                Image(systemName: "circle.fill")
                    .font(.system(size: 7, weight: .bold))
                    .symbolEffect(.pulse, options: .repeating)
            case .saved:
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .heavy))
            case .saving, .locating:
                ProgressView()
                    .controlSize(.mini)
                    .tint(.white)
            default:
                EmptyView()
            }

            Text(status.title)
                .font(.montserrat(size: fontSize, weight: .semibold))
                .tracking(1.2)
                .lineLimit(1)
                .fixedSize()
                .contentTransition(.opacity)
        }
        .foregroundStyle(status.foreground)
        .padding(.horizontal, fontSize * 0.9)
        .padding(.vertical, fontSize * 0.45)
        .background(Capsule().fill(status.background))
        .animation(.smooth(duration: 0.25), value: status)
    }
}
