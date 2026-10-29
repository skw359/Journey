import SwiftUI
import MapKit

struct HomeScreen: View {
    @Environment(LocationService.self) private var locationService
    @Environment(UploadManager.self) private var uploadManager
    @Binding var isLocked: Bool
    @State private var liveMapCameraMode: LiveMapCameraMode = .followUser
    @State private var showFullscreenMap = false
    @State private var showStopConfirmation = false
    @State private var geocodingService = GeocodingService.shared

    @AppStorage(AppConstants.confirmBeforeStoppingKey) private var confirmBeforeStopping = true
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    private let buttonHeight: CGFloat = 72
    private let bottomInset: CGFloat = 12
    private let cardButtonSpacing: CGFloat = 12

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

    var body: some View {
        GeometryReader { geo in
            let collapsedHeight = max(100, geo.size.height * 0.14)
            let expandedHeight = min(geo.size.height * 0.62, collapsedHeight + 85)

            ZStack {
                Color.black.ignoresSafeArea()

                LiveMapView(
                    coordinates: locationService.routeCoordinates,
                    userLocation: locationService.latestLocation?.coordinate,
                    cameraMode: liveMapCameraMode,
                    mapStyle: .standard,
                    isRecording: locationService.isRecording,
                    onUserInteraction: {
                        liveMapCameraMode = .manual
                    }
                )
                .ignoresSafeArea()

                if locationService.isRecording && locationService.routeCoordinates.isEmpty {
                    gpsWaitingPill
                }

                topOverlay
                rightOverlay

                VStack(spacing: cardButtonSpacing) {
                    Spacer(minLength: 0)

                    FloatingStatsCard(
                        collapsedHeight: collapsedHeight,
                        expandedHeight: expandedHeight,
                        totalSeconds: locationService.totalSeconds,
                        distanceMiles: locationService.distanceMiles,
                        currentSpeedMph: locationService.currentSpeedMph,
                        averageSpeedMph: locationService.averageSpeedMph,
                        topSpeedMph: locationService.topSpeedMph,
                        pointCount: locationService.pointCount,
                        useMetric: useMetricUnits,
                        roadLabel: roadLabel,
                        isRecording: locationService.isRecording
                    )

                    StartStopButton(isRecording: locationService.isRecording) {
                        handleStartStopTap()
                    }
                    .frame(height: buttonHeight)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, bottomInset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
        }
        .onChange(of: locationService.latestLocation) { _, newLocation in
            guard let location = newLocation else { return }
            geocodingService.updateLocation(location, speedMph: locationService.currentSpeedMph)
        }
        .onChange(of: locationService.isRecording) { _, _ in
            liveMapCameraMode = .followUser
        }
        .fullScreenCover(isPresented: $showFullscreenMap) {
            FullscreenMapScreen(
                coordinates: locationService.routeCoordinates,
                userLocation: locationService.latestLocation?.coordinate,
                pointCount: locationService.pointCount,
                distanceMiles: locationService.distanceMiles
            )
        }
        .alert("Stop Recording?", isPresented: $showStopConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Stop", role: .destructive) {
                stopRecording()
            }
        } message: {
            Text("Are you sure you want to stop recording this journey?")
        }
    }

    private var topOverlay: some View {
        VStack {
            HStack {
                HStack(spacing: 8) {
                    Image("Logo")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 22, height: 22)
                    Text("Journey")
                        .font(.montserrat(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    Capsule()
                        .fill(.ultraThinMaterial)
                        .overlay(
                            Capsule()
                                .stroke(Color.white.opacity(0.1), lineWidth: 1)
                        )
                )

                Spacer()

                Button {
                    withAnimation { isLocked = true }
                } label: {
                    Image(systemName: "lock")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 42, height: 42)
                        .background(
                            Circle()
                                .fill(.ultraThinMaterial)
                                .overlay(
                                    Circle()
                                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                                )
                        )
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            Spacer()
        }
    }

    private var rightOverlay: some View {
        VStack {
            HStack {
                Spacer()
                VStack(spacing: 10) {
                    floatingIconButton(systemName: "arrow.up.left.and.arrow.down.right") {
                        showFullscreenMap = true
                    }
                    floatingIconButton(
                        systemName: "location.fill",
                        tint: liveMapCameraMode == .followUser ? AppConstants.journeyGreen : .white
                    ) {
                        liveMapCameraMode = .followUser
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 68)

            Spacer()
        }
    }

    private var gpsWaitingPill: some View {
        VStack {
            Spacer()
            HStack(spacing: 8) {
                ProgressView()
                    .tint(AppConstants.journeyGreen)
                Text("Waiting for GPS...")
                    .font(.montserrat(size: 13, weight: .medium))
                    .foregroundColor(.white.opacity(0.9))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                Capsule()
                    .fill(.ultraThinMaterial)
                    .overlay(
                        Capsule()
                            .stroke(Color.white.opacity(0.12), lineWidth: 1)
                    )
            )
            Spacer()
        }
        .allowsHitTesting(false)
    }

    private func floatingIconButton(systemName: String, tint: Color = .white, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(tint)
                .frame(width: 42, height: 42)
                .background(
                    Circle()
                        .fill(.ultraThinMaterial)
                        .overlay(
                            Circle()
                                .stroke(Color.white.opacity(0.1), lineWidth: 1)
                        )
                )
        }
    }

    private func handleStartStopTap() {
        if locationService.isRecording {
            if confirmBeforeStopping {
                showStopConfirmation = true
            } else {
                stopRecording()
            }
        } else {
            locationService.startRecording()
        }
    }

    private func stopRecording() {
        if let zipURL = locationService.stopRecording() {
            uploadManager.enqueue(fileURL: zipURL, source: "iphone")
            Task {
                if let item = uploadManager.queue.first {
                    _ = await uploadManager.upload(item: item)
                }
            }
        }
    }
}
