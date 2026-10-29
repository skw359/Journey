import SwiftUI
import MapKit

struct FullscreenMapScreen: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false
    @State private var cameraMode: LiveMapCameraMode
    @State private var mapStyle: LiveMapStyle = .standard
    let coordinates: [CLLocationCoordinate2D]
    let userLocation: CLLocationCoordinate2D?
    let pointCount: Int
    let distanceMiles: Double

    init(
        coordinates: [CLLocationCoordinate2D],
        userLocation: CLLocationCoordinate2D?,
        pointCount: Int,
        distanceMiles: Double,
        initialCameraMode: LiveMapCameraMode = .followUser
    ) {
        self.coordinates = coordinates
        self.userLocation = userLocation
        self.pointCount = pointCount
        self.distanceMiles = distanceMiles
        _cameraMode = State(initialValue: initialCameraMode)
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
                }
            )
            .ignoresSafeArea()

            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.black.opacity(0.7)))
                    }
                    Spacer()
                    Menu {
                        mapStyleButton(.standard, title: "Standard")
                        mapStyleButton(.hybrid, title: "Hybrid")
                        mapStyleButton(.satellite, title: "Satellite")
                    } label: {
                        Image(systemName: mapStyle.iconName)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.black.opacity(0.7)))
                    }
                    .accessibilityLabel("Map style")
                    .accessibilityValue(mapStyle.accessibilityLabel)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)

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
                            .foregroundColor(.gray)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(
                        Capsule()
                            .fill(Color.black.opacity(0.7))
                    )

                    Spacer()

                    VStack(spacing: 8) {
                        Button {
                            cameraMode = .overview
                        } label: {
                            Image(systemName: "scope")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(cameraMode == .overview ? AppConstants.journeyGreen : .white)
                                .frame(width: 40, height: 40)
                                .background(Circle().fill(Color.black.opacity(0.7)))
                        }
                        Button {
                            cameraMode = .followUser
                        } label: {
                            Image(systemName: "location.fill")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(cameraMode == .followUser ? AppConstants.journeyGreen : .white)
                                .frame(width: 40, height: 40)
                                .background(Circle().fill(Color.black.opacity(0.7)))
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 60)
            }
        }
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
