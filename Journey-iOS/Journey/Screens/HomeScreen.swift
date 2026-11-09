// Home screen with the live map and recording controls.

import SwiftUI
import MapKit

enum RecordingPhase: Equatable {
    case idle
    case recording
    case finished
}

struct FinishedJourney: Identifiable {
    enum UploadState: Equatable {
        case saving
        case saved
        case notSaved
        case failed
    }

    let id = UUID()
    let startedAt: Date
    let place: String
    let coordinates: [CLLocationCoordinate2D]
    let metrics: RecordingCaption.Metrics
    var uploadState: UploadState = .saving
}

struct HomeScreen: View {
    @Environment(LocationService.self) private var locationService
    @Environment(UploadManager.self) private var uploadManager
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Binding var isLocked: Bool
    let isActive: Bool
    let onViewJourney: (Date) -> Void
    let onViewUploads: () -> Void

    @State private var liveMapCameraMode: LiveMapCameraMode = .followUser
    @State private var showFullscreenMap = false
    @State private var stopConfirmationStartedAt: Date?
    @State private var geocodingService = GeocodingService.shared
    @State private var finishedJourney: FinishedJourney?
    @State private var panelHeight: CGFloat = 0

    @AppStorage(AppConstants.confirmBeforeStoppingKey) private var confirmBeforeStopping = true

    private let controlHeight: CGFloat = 62
    private let mapControlSize: CGFloat = 46
    private let mapControlSpacing: CGFloat = 10
    private let topInset: CGFloat = 8
    private let stopConfirmationTimeout: Duration = .seconds(5)
    private let stopConfirmationTapDelay: TimeInterval = 0.5

    private var isConfirmingStop: Bool {
        stopConfirmationStartedAt != nil
    }

    private var mapControlsHeight: CGFloat {
        topInset + mapControlSize * 3 + mapControlSpacing
    }

    private var phase: RecordingPhase {
        if locationService.isRecording { return .recording }
        return finishedJourney == nil ? .idle : .finished
    }

    private var roadLabel: String {
        let road = geocodingService.currentRoad
        let city = geocodingService.currentCity
        let state = geocodingService.currentState
        let cityState = [city, state].filter { !$0.isEmpty }.joined(separator: ", ")
        if !road.isEmpty {
            return cityState.isEmpty ? road : "\(road), \(cityState)"
        }
        return cityState
    }

    private var liveMetrics: RecordingCaption.Metrics {
        RecordingCaption.Metrics(
            totalSeconds: locationService.totalSeconds,
            distanceMiles: locationService.distanceMiles,
            currentSpeedMph: locationService.currentSpeedMph,
            averageSpeedMph: locationService.averageSpeedMph,
            topSpeedMph: locationService.topSpeedMph,
            pointCount: locationService.pointCount,
            elevationMeters: currentElevationMeters
        )
    }

    private var currentElevationMeters: Double? {
        guard let location = locationService.latestLocation, location.verticalAccuracy >= 0 else { return nil }
        return location.altitude
    }

    private var displayedRoute: [CLLocationCoordinate2D] {
        finishedJourney?.coordinates ?? locationService.routeCoordinates
    }

    private var phaseAnimation: Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.5, dampingFraction: 0.84)
    }

    var body: some View {
        GeometryReader { geo in
            let safeArea = geo.safeAreaInsets

            ZStack {
                Color.black.ignoresSafeArea()

                LiveMapView(
                    coordinates: displayedRoute,
                    userLocation: locationService.latestLocation?.coordinate,
                    cameraMode: liveMapCameraMode,
                    mapStyle: .standard,
                    isRecording: locationService.isRecording,
                    onUserInteraction: {
                        liveMapCameraMode = .manual
                    },
                    obscuredInsets: UIEdgeInsets(top: 0, left: 10, bottom: panelHeight + 12, right: 10),
                    overviewPadding: UIEdgeInsets(top: 40, left: 36, bottom: 60, right: 84),
                    compassTopInset: mapControlsHeight + 10
                )
                .ignoresSafeArea()

                scrims(in: geo.size, safeArea: safeArea)

                Group {
                    bottomPanel
                        .frame(maxHeight: .infinity, alignment: .bottom)

                    topOverlay
                        .frame(maxHeight: .infinity, alignment: .top)
                }
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .animation(phaseAnimation, value: phase)
        .animation(phaseAnimation, value: isConfirmingStop)
        .animation(.smooth(duration: 0.3), value: finishedJourney?.uploadState)
        .task(id: isConfirmingStop) {
            guard isConfirmingStop, !voiceOverEnabled else { return }
            try? await Task.sleep(for: stopConfirmationTimeout)
            guard !Task.isCancelled else { return }
            stopConfirmationStartedAt = nil
        }
        .onChange(of: locationService.latestLocation) { _, newLocation in
            guard isActive, let location = newLocation else { return }
            geocodingService.updateLocation(location, speedMph: locationService.currentSpeedMph)
        }
        .onChange(of: locationService.isRecording) { _, isRecording in
            if isRecording { finishedJourney = nil }
            liveMapCameraMode = finishedJourney == nil ? .followUser : .overview
        }
        .fullScreenCover(isPresented: $showFullscreenMap) {
            FullscreenMapScreen(
                coordinates: displayedRoute,
                userLocation: locationService.latestLocation?.coordinate,
                pointCount: finishedJourney?.metrics.pointCount ?? locationService.pointCount,
                distanceMiles: finishedJourney?.metrics.distanceMiles ?? locationService.distanceMiles
            )
        }
        .sensoryFeedback(.success, trigger: finishedJourney?.uploadState) { _, state in
            state == .saved
        }
        .sensoryFeedback(.error, trigger: finishedJourney?.uploadState) { _, state in
            state == .failed
        }
    }

    private func scrims(in size: CGSize, safeArea: EdgeInsets) -> some View {
        let fullHeight = size.height + safeArea.top + safeArea.bottom

        return ZStack {
            LinearGradient(
                colors: [.black.opacity(0.6), .black.opacity(0)],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: safeArea.top + 76)
            .frame(maxHeight: .infinity, alignment: .top)

            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black.opacity(0.55), location: 0.3),
                    .init(color: .black.opacity(0.85), location: 0.62),
                    .init(color: .black, location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: min(panelHeight + safeArea.bottom + 96, fullHeight))
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private var topOverlay: some View {
        HStack(alignment: .top) {
            Spacer()

            mapControls
        }
        .padding(.horizontal, 20)
        .padding(.top, topInset)
    }

    private var mapControls: some View {
        GlassEffectContainer(spacing: mapControlSpacing) {
            VStack(spacing: mapControlSpacing) {
                Button {
                    withAnimation { isLocked = true }
                } label: {
                    mapControlIcon("lock.fill")
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Lock Screen")

                VStack(spacing: 0) {
                    Button {
                        showFullscreenMap = true
                    } label: {
                        mapControlIcon("arrow.up.left.and.arrow.down.right")
                    }
                    .accessibilityLabel("Full-Screen Map")

                    Button {
                        withAnimation(.smooth(duration: 0.25)) {
                            liveMapCameraMode = .followUser
                        }
                    } label: {
                        mapControlIcon(
                            liveMapCameraMode == .followUser ? "location.fill" : "location",
                            tint: liveMapCameraMode == .followUser ? AppConstants.journeyGreen : .white
                        )
                        .contentTransition(.symbolEffect(.replace))
                    }
                    .accessibilityLabel("Follow My Location")
                    .accessibilityValue(liveMapCameraMode == .followUser ? "On" : "Off")
                }
                .glassEffect(.regular.interactive(), in: .capsule)
            }
        }
        .buttonStyle(.plain)
    }

    private func mapControlIcon(_ systemName: String, tint: Color = .white) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: mapControlSize, height: mapControlSize)
            .contentShape(.rect)
    }

    private var bottomPanel: some View {
        ZStack(alignment: .bottomTrailing) {
            RecordingCaption(
                phase: phase,
                metrics: finishedJourney?.metrics ?? liveMetrics,
                place: finishedJourney?.place ?? roadLabel,
                hasLocation: locationService.latestLocation != nil,
                isWaitingForGPS: locationService.isRecording && locationService.routeCoordinates.isEmpty,
                uploadState: finishedJourney?.uploadState,
                trailingInset: phase == .recording ? controlHeight + 12 : 0,
                hidesBottomRows: isConfirmingStop
            )
            .allowsHitTesting(false)
            .padding(.bottom, phase == .recording ? 0 : controlHeight + 16)

            actionButtons
        }
        .frame(maxWidth: verticalSizeClass == .compact ? 400 : 560)
        .padding(.horizontal, 20)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
            panelHeight = height
        }
    }

    private var actionButtons: some View {
        HStack(spacing: 10) {
            if isStopCircle {
                Spacer(minLength: 0)
            }

            primaryButton

            if isConfirmingStop || (phase == .finished && finishedJourney?.uploadState != .notSaved) {
                Button(isConfirmingStop ? "Keep Recording" : "Done", systemImage: "xmark") {
                    if isConfirmingStop {
                        stopConfirmationStartedAt = nil
                    } else {
                        dismissFinishedJourney()
                    }
                }
                .labelStyle(.iconOnly)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: controlHeight, height: controlHeight)
                .contentShape(.circle)
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .transition(.opacity.combined(with: .scale(scale: 0.6)))
            }
        }
    }

    private var isStopCircle: Bool {
        phase == .recording && !isConfirmingStop
    }

    private var primaryButton: some View {
        Button(action: handlePrimaryTap) {
            primaryLabel
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .frame(width: isStopCircle ? controlHeight : nil, height: controlHeight)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .disabled(finishedJourney?.uploadState == .saving)
        .glassEffect(.regular.tint(primaryTint).interactive(), in: .capsule)
    }

    private var primaryTint: Color {
        switch phase {
        case .idle: AppConstants.journeyGreen
        case .recording: AppConstants.redAction
        case .finished:
            finishedJourney?.uploadState == .saved ? AppConstants.journeyGreen : .white.opacity(0.14)
        }
    }

    @ViewBuilder
    private var primaryLabel: some View {
        switch phase {
        case .idle:
            actionLabel("Start Journey", systemImage: "play.fill", color: .black)
        case .recording:
            if isConfirmingStop {
                actionLabel("Stop Recording", systemImage: "stop.fill", color: .white)
                    .accessibilityLabel("Confirm Stop Recording")
            } else {
                Image(systemName: "stop.fill")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(.white)
                    .accessibilityLabel("Stop Recording")
                    .transition(.opacity.animation(.easeOut(duration: 0.12)))
            }
        case .finished:
            switch finishedJourney?.uploadState ?? .saving {
            case .saving:
                HStack(spacing: 10) {
                    ProgressView()
                        .tint(.white)
                    Text("Saving...")
                        .font(.montserrat(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                }
                .transition(.opacity.animation(.easeOut(duration: 0.12)))
            case .saved:
                actionLabel("View Journey", systemImage: "arrow.up.forward", color: .black)
            case .notSaved:
                actionLabel("Done", systemImage: "checkmark", color: .white)
            case .failed:
                actionLabel("View Uploads", systemImage: "arrow.up.circle", color: .white)
            }
        }
    }

    private func actionLabel(_ title: String, systemImage: String, color: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .bold))
            Text(title)
                .font(.montserrat(size: 17, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(color)
        .transition(.opacity.animation(.easeOut(duration: 0.12)))
    }

    private func handlePrimaryTap() {
        switch phase {
        case .idle, .recording:
            handleStartStopTap()
        case .finished:
            switch finishedJourney?.uploadState ?? .saving {
            case .saving:
                break
            case .saved:
                if let startedAt = finishedJourney?.startedAt {
                    onViewJourney(startedAt)
                }
                dismissFinishedJourney()
            case .notSaved:
                dismissFinishedJourney()
            case .failed:
                onViewUploads()
                dismissFinishedJourney()
            }
        }
    }

    private func handleStartStopTap() {
        if locationService.isRecording {
            guard confirmBeforeStopping else {
                stopRecording()
                return
            }
            if let startedAt = stopConfirmationStartedAt {
                if Date().timeIntervalSince(startedAt) >= stopConfirmationTapDelay {
                    stopRecording()
                }
            } else {
                stopConfirmationStartedAt = Date()
                AccessibilityNotification.Announcement("Tap again to stop recording").post()
            }
        } else {
            locationService.startRecording()
        }
    }

    private func stopRecording() {
        stopConfirmationStartedAt = nil

        let finished = FinishedJourney(
            startedAt: Date().addingTimeInterval(-locationService.duration),
            place: roadLabel,
            coordinates: locationService.routeCoordinates,
            metrics: liveMetrics
        )

        if let zipURL = locationService.stopRecording() {
            finishedJourney = finished
            liveMapCameraMode = .overview
            uploadManager.enqueue(fileURL: zipURL, source: "iphone")
            Task {
                if let item = uploadManager.queue.first {
                    let saved = await uploadManager.upload(item: item)
                    showUploadResult(of: item, saved: saved, for: finished.id)
                }
            }
        }
    }

    private func showUploadResult(of item: UploadQueueItem, saved: Bool, for journeyID: UUID) {
        guard finishedJourney?.id == journeyID else { return }
        let didFail = uploadManager.queue.contains { $0.id == item.id }
        finishedJourney?.uploadState = saved ? .saved : (didFail ? .failed : .notSaved)
    }

    private func dismissFinishedJourney() {
        finishedJourney = nil
        liveMapCameraMode = .followUser
    }
}
