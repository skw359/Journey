import SwiftUI
import MapKit

struct RouteCardView: View {
    let detail: JourneyDetail
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false
    @State private var hasUserMovedMap = false
    @State private var recenterToken = 0

    private var routeCoordinates: [CLLocationCoordinate2D] {
        (detail.coordinates ?? []).compactMap { arr -> CLLocationCoordinate2D? in
            guard arr.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: arr[0], longitude: arr[1])
        }
    }

    var body: some View {
        ZStack {
            // Full-screen clean route map
            RouteCardMapView(
                coordinates: routeCoordinates,
                hasUserMovedMap: $hasUserMovedMap,
                recenterToken: recenterToken
            )
            .ignoresSafeArea()

            // Bottom branded overlay
            VStack(spacing: 0) {
                Spacer()

                // Gradient fade into bottom bar
                LinearGradient(
                    colors: [.clear, .black.opacity(0.9)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 160)

                // Branded info bar
                VStack(spacing: 10) {
                    HStack(spacing: 10) {
                        Image("Logo")
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 24, height: 24)

                        Text("Journey")
                            .font(.montserrat(size: 20, weight: .bold))
                            .foregroundColor(.white)
                    }

                    HStack(spacing: 14) {
                        Text("\(DistanceFormatter.format(detail.distanceDouble, useMetric: useMetricUnits)) \(DistanceFormatter.unit(useMetric: useMetricUnits))")
                            .font(.montserrat(size: 24, weight: .semibold))
                            .foregroundColor(.white.opacity(0.9))

                        Text("\u{2022}")
                            .font(.system(size: 18))
                            .foregroundColor(.white.opacity(0.45))

                        Text(DurationFormatter.formatReadable(compact: detail.duration))
                            .font(.montserrat(size: 24, weight: .semibold))
                            .foregroundColor(.white.opacity(0.9))
                    }
                }
                .offset(y: -20)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
                .padding(.top, 4)
                .padding(.bottom, 60)
                .background(Color.black.opacity(0.85))
            }

            // Close button
            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.black.opacity(0.5)))
                    }
                    .padding(.trailing, 16)
                    .padding(.top, 8)
                }
                Spacer()
            }

            // Recenter button (visible only after the user moves the map)
            if hasUserMovedMap {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button {
                            recenterToken &+= 1
                            hasUserMovedMap = false
                        } label: {
                            Image(systemName: "scope")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(.white)
                                .frame(width: 44, height: 44)
                                .background(Circle().fill(Color.black.opacity(0.65)))
                                .overlay(Circle().stroke(Color.white.opacity(0.15), lineWidth: 1))
                        }
                        .padding(.trailing, 16)
                        .padding(.bottom, 180)
                    }
                }
                .transition(.opacity.combined(with: .scale))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: hasUserMovedMap)
        .background(Color.black.ignoresSafeArea())
        .statusBarHidden(true)
    }
}

// MARK: - Clean Route Map (no annotations, interaction disabled)

struct RouteCardMapView: UIViewRepresentable {
    let coordinates: [CLLocationCoordinate2D]
    @Binding var hasUserMovedMap: Bool
    let recenterToken: Int

    func makeUIView(context: Context) -> MKMapView {
        let mapView = MKMapView()
        mapView.delegate = context.coordinator
        mapView.isZoomEnabled = true
        mapView.isScrollEnabled = true
        mapView.isRotateEnabled = true
        mapView.isPitchEnabled = true
        mapView.showsUserLocation = false
        mapView.overrideUserInterfaceStyle = .dark
        mapView.showsTraffic = false
        mapView.showsBuildings = false

        // Muted style hides city/road labels for a clean look
        let config = MKStandardMapConfiguration(emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        config.showsTraffic = false
        mapView.preferredConfiguration = config

        // Detect user-driven movement so the recenter button can appear
        let pan = UIPanGestureRecognizer(target: context.coordinator,
                                         action: #selector(Coordinator.handleUserGesture(_:)))
        pan.delegate = context.coordinator
        mapView.addGestureRecognizer(pan)
        let pinch = UIPinchGestureRecognizer(target: context.coordinator,
                                             action: #selector(Coordinator.handleUserGesture(_:)))
        pinch.delegate = context.coordinator
        mapView.addGestureRecognizer(pinch)
        let rotate = UIRotationGestureRecognizer(target: context.coordinator,
                                                 action: #selector(Coordinator.handleUserGesture(_:)))
        rotate.delegate = context.coordinator
        mapView.addGestureRecognizer(rotate)

        context.coordinator.parent = self
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.parent = self

        // Add the polyline once when coordinates first arrive
        if mapView.overlays.isEmpty, coordinates.count >= 2 {
            let polyline = MKPolyline(coordinates: coordinates, count: coordinates.count)
            mapView.addOverlay(polyline)
            context.coordinator.fitPolyline(in: mapView, animated: false)
            context.coordinator.lastRecenterToken = recenterToken
        }

        // Refit when the recenter button bumps the token
        if context.coordinator.lastRecenterToken != recenterToken {
            context.coordinator.lastRecenterToken = recenterToken
            context.coordinator.fitPolyline(in: mapView, animated: true)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
        var parent: RouteCardMapView?
        var lastRecenterToken: Int = 0

        @objc func handleUserGesture(_ recognizer: UIGestureRecognizer) {
            guard recognizer.state == .began else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, let parent = self.parent, !parent.hasUserMovedMap else { return }
                self.parent?.hasUserMovedMap = true
            }
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }

        func fitPolyline(in mapView: MKMapView, animated: Bool) {
            guard let polyline = mapView.overlays.first(where: { $0 is MKPolyline }) as? MKPolyline else { return }
            let padding = UIEdgeInsets(top: 100, left: 60, bottom: 220, right: 60)
            mapView.setVisibleMapRect(polyline.boundingMapRect, edgePadding: padding, animated: animated)
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let polyline = overlay as? MKPolyline {
                let renderer = MKPolylineRenderer(polyline: polyline)
                renderer.strokeColor = AppConstants.journeyGreenUIColor
                renderer.lineWidth = 4
                renderer.lineCap = .round
                return renderer
            }
            return MKOverlayRenderer(overlay: overlay)
        }
    }
}
