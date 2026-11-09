// Fullscreen map of a journey.

import SwiftUI
import MapKit

struct FullscreenMapScreen: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false
    @State private var cameraMode: LiveMapCameraMode
    @State private var mapStyle: LiveMapStyle = .standard
    @State private var mapIsLive: Bool
    let coordinates: [CLLocationCoordinate2D]
    let userLocation: CLLocationCoordinate2D?
    let pointCount: Int
    let distanceMiles: Double
    let onClose: (() -> Void)?
    let initialMapRect: MKMapRect?
    let showsEndMarker: Bool
    let onMapRendered: (() -> Void)?

    init(
        coordinates: [CLLocationCoordinate2D],
        userLocation: CLLocationCoordinate2D?,
        pointCount: Int,
        distanceMiles: Double,
        initialCameraMode: LiveMapCameraMode = .followUser,
        initialMapRect: MKMapRect? = nil,
        showsEndMarker: Bool = false,
        onMapRendered: (() -> Void)? = nil,
        onClose: (() -> Void)? = nil
    ) {
        self.coordinates = coordinates
        self.userLocation = userLocation
        self.pointCount = pointCount
        self.distanceMiles = distanceMiles
        self.initialMapRect = initialMapRect
        self.showsEndMarker = showsEndMarker
        self.onMapRendered = onMapRendered
        self.onClose = onClose
        _cameraMode = State(initialValue: initialMapRect == nil ? initialCameraMode : .manual)
        _mapIsLive = State(initialValue: initialMapRect == nil)
    }

    var body: some View {
        ZStack {
            LiveMapView(
                coordinates: coordinates,
                userLocation: userLocation,
                cameraMode: cameraMode,
                mapStyle: mapStyle,
                isRecording: true,
                onUserInteraction: {
                    cameraMode = .manual
                },
                initialMapRect: initialMapRect,
                showsEndMarker: showsEndMarker,
                onRendered: onMapRendered,
                onUserGesture: { mapIsLive = true }
            )
            .opacity(mapIsLive ? 1 : 0.02)
            .onChange(of: cameraMode) { mapIsLive = true }
            .onChange(of: mapStyle) { mapIsLive = true }
            .ignoresSafeArea()

            VStack {
                HStack {
                    Button {
                        if let onClose {
                            onClose()
                        } else {
                            dismiss()
                        }
                    } label: {
                        chromeIcon("xmark")
                    }
                    .accessibilityLabel("Close")
                    Spacer()
                    Menu {
                        mapStyleButton(.standard, title: "Standard")
                        mapStyleButton(.hybrid, title: "Hybrid")
                        mapStyleButton(.satellite, title: "Satellite")
                    } label: {
                        chromeIcon(mapStyle.iconName)
                    }
                    .menuStyle(.button)
                    .accessibilityLabel("Map style")
                    .accessibilityValue(mapStyle.accessibilityLabel)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .padding(.horizontal, 20)
                .padding(.top, 6)

                Spacer()

                HStack(alignment: .bottom) {
                    HStack(spacing: 16) {
                        HStack(spacing: 6) {
                            Image(systemName: "point.bottomleft.forward.to.point.topright.scurvepath")
                                .font(.system(size: 14))
                                .foregroundColor(.white)
                            Text("\(DistanceFormatter.format(distanceMiles, useMetric: useMetricUnits)) \(DistanceFormatter.unit(useMetric: useMetricUnits))")
                                .font(.montserrat(size: 14, weight: .semibold))
                                .foregroundColor(.white)
                        }

                        Text("\(pointCount) pts")
                            .font(.montserrat(size: 14))
                            .foregroundColor(.white.opacity(0.7))
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .glassEffect(.regular, in: .capsule)

                    Spacer()

                    VStack(spacing: 10) {
                        Button {
                            cameraMode = .overview
                        } label: {
                            chromeIcon("scope", tint: cameraMode == .overview ? AppConstants.journeyGreen : .white)
                        }
                        .accessibilityLabel("Show Whole Route")
                        Button {
                            cameraMode = .followUser
                        } label: {
                            chromeIcon(
                                cameraMode == .followUser ? "location.fill" : "location",
                                tint: cameraMode == .followUser ? AppConstants.journeyGreen : .white
                            )
                        }
                        .accessibilityLabel("Follow My Location")
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 60)
            }
        }
    }

    private func chromeIcon(_ systemName: String, tint: Color = .white) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 26, height: 26)
    }

    @ViewBuilder
    private func mapStyleButton(_ style: LiveMapStyle, title: String) -> some View {
        Button {
            mapStyle = style
        } label: {
            Label(title, systemImage: mapStyle == style ? "checkmark" : style.iconName)
        }
    }
}
