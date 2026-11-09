// Live map shown while recording.

import SwiftUI
import MapKit

enum LiveMapCameraMode {
    case followUser
    case overview
    case manual
}

enum LiveMapStyle: CaseIterable {
    case standard
    case hybrid
    case satellite

    var mapType: MKMapType {
        switch self {
        case .standard:
            return .standard
        case .hybrid:
            return .hybrid
        case .satellite:
            return .satellite
        }
    }

    var iconName: String {
        switch self {
        case .standard:
            return "map"
        case .hybrid:
            return "square.2.layers.3d"
        case .satellite:
            return "globe.americas.fill"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .standard:
            return "Standard map"
        case .hybrid:
            return "Hybrid map"
        case .satellite:
            return "Satellite map"
        }
    }

    var next: LiveMapStyle {
        let allCases = Self.allCases
        guard let currentIndex = allCases.firstIndex(of: self) else { return .standard }
        let nextIndex = allCases.index(after: currentIndex)
        return nextIndex == allCases.endIndex ? allCases[allCases.startIndex] : allCases[nextIndex]
    }
}

final class AttributionHiddenMapView: MKMapView {
    var initialVisibleRect: MKMapRect?

    override func layoutSubviews() {
        super.layoutSubviews()
        hideAttribution(in: self)
        if let rect = initialVisibleRect, window != nil, bounds.width > 1, bounds.height > 1 {
            initialVisibleRect = nil
            setVisibleMapRect(partInsideSafeArea(of: rect), animated: false)
        }
    }

    private func partInsideSafeArea(of rect: MKMapRect) -> MKMapRect {
        let mapPointsPerX = rect.width / bounds.width
        let mapPointsPerY = rect.height / bounds.height
        return MKMapRect(
            x: rect.minX + safeAreaInsets.left * mapPointsPerX,
            y: rect.minY + safeAreaInsets.top * mapPointsPerY,
            width: rect.width - (safeAreaInsets.left + safeAreaInsets.right) * mapPointsPerX,
            height: rect.height - (safeAreaInsets.top + safeAreaInsets.bottom) * mapPointsPerY
        )
    }

    override func didAddSubview(_ subview: UIView) {
        super.didAddSubview(subview)
        hideAttribution(in: subview)
    }

    private func hideAttribution(in view: UIView) {
        for subview in view.subviews {
            let name = String(describing: type(of: subview))
            if name.contains("Attribution") || name.contains("AppleLogo") {
                subview.isHidden = true
            } else {
                hideAttribution(in: subview)
            }
        }
    }
}

struct LiveMapView: UIViewRepresentable {
    let coordinates: [CLLocationCoordinate2D]
    let userLocation: CLLocationCoordinate2D?
    let cameraMode: LiveMapCameraMode
    let mapStyle: LiveMapStyle
    let isRecording: Bool
    var onUserInteraction: (() -> Void)? = nil
    var obscuredInsets: UIEdgeInsets = .zero
    var overviewPadding = UIEdgeInsets(top: 48, left: 32, bottom: 48, right: 32)
    var compassTopInset: CGFloat?
    var initialMapRect: MKMapRect?
    var showsEndMarker = false
    var onRendered: (() -> Void)?
    var onUserGesture: (() -> Void)?

    func makeUIView(context: Context) -> MKMapView {
        let mapView = AttributionHiddenMapView()
        mapView.initialVisibleRect = initialMapRect
        mapView.delegate = context.coordinator
        mapView.showsUserLocation = true
        mapView.isZoomEnabled = true
        mapView.isScrollEnabled = true
        mapView.isRotateEnabled = true
        mapView.overrideUserInterfaceStyle = .dark
        context.coordinator.applyMapStyle(on: mapView, style: mapStyle)
        if let compassTopInset {
            mapView.showsCompass = false
            let compass = MKCompassButton(mapView: mapView)
            compass.compassVisibility = .adaptive
            compass.translatesAutoresizingMaskIntoConstraints = false
            mapView.addSubview(compass)
            NSLayoutConstraint.activate([
                compass.topAnchor.constraint(equalTo: mapView.safeAreaLayoutGuide.topAnchor, constant: compassTopInset),
                compass.trailingAnchor.constraint(equalTo: mapView.safeAreaLayoutGuide.trailingAnchor, constant: -21)
            ])
        }
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.applyMapStyle(on: mapView, style: mapStyle)
        let insetsDidChange = context.coordinator.applyObscuredInsets(on: mapView)

        let routeDidChange = context.coordinator.syncRoute(on: mapView, coordinates: coordinates)

        if cameraMode != .manual {
            context.coordinator.hasPendingManualUnlock = false
        }

        switch cameraMode {
        case .followUser:
            context.coordinator.hasShownInitialRegion = true
            context.coordinator.applyFollowCamera(on: mapView, userLocation: userLocation)
        case .overview:
            context.coordinator.hasShownInitialRegion = true
            if routeDidChange || insetsDidChange || context.coordinator.lastCameraMode != .overview {
                context.coordinator.applyOverviewCamera(
                    on: mapView,
                    fallbackCoordinate: coordinates.first ?? userLocation,
                    animated: context.coordinator.lastCameraMode != nil && !routeDidChange
                )
            }
        case .manual:
            if !context.coordinator.hasShownInitialRegion {
                context.coordinator.hasShownInitialRegion = true
                if initialMapRect == nil {
                    context.coordinator.applyOverviewCamera(
                        on: mapView,
                        fallbackCoordinate: coordinates.first ?? userLocation,
                        animated: false
                    )
                }
            }
        }

        context.coordinator.lastCameraMode = cameraMode
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    class Coordinator: NSObject, MKMapViewDelegate {
        var parent: LiveMapView
        var hasShownInitialRegion = false
        var hasPendingManualUnlock = false
        var lastCameraMode: LiveMapCameraMode?
        private var lastMapStyle: LiveMapStyle?
        private var isPerformingProgrammaticCameraChange = false
        private var routeOverlay: MKPolyline?
        private var startAnnotation: MKPointAnnotation?
        private var endAnnotation: RouteEndpointAnnotation?
        private var renderedCoordinateCount = 0
        private var renderedFirstCoordinate: CLLocationCoordinate2D?
        private var renderedLastCoordinate: CLLocationCoordinate2D?

        init(parent: LiveMapView) {
            self.parent = parent
        }

        func applyMapStyle(on mapView: MKMapView, style: LiveMapStyle) {
            guard lastMapStyle != style else { return }

            if style == .standard {
                mapView.preferredConfiguration = MKStandardMapConfiguration(emphasisStyle: .muted)
            } else {
                mapView.mapType = style.mapType
            }
            mapView.pointOfInterestFilter = .excludingAll
            mapView.showsTraffic = false
            lastMapStyle = style
        }

        func applyObscuredInsets(on mapView: MKMapView) -> Bool {
            guard parent.obscuredInsets != .zero, mapView.layoutMargins != parent.obscuredInsets else { return false }
            mapView.layoutMargins = parent.obscuredInsets
            return true
        }

        @discardableResult
        func syncRoute(on mapView: MKMapView, coordinates: [CLLocationCoordinate2D]) -> Bool {
            let firstCoordinate = coordinates.first
            let lastCoordinate = coordinates.last
            let routeDidChange =
                coordinates.count != renderedCoordinateCount ||
                !coordinatesMatch(firstCoordinate, renderedFirstCoordinate) ||
                !coordinatesMatch(lastCoordinate, renderedLastCoordinate)

            guard routeDidChange else { return false }

            renderedCoordinateCount = coordinates.count
            renderedFirstCoordinate = firstCoordinate
            renderedLastCoordinate = lastCoordinate

            if let routeOverlay {
                mapView.removeOverlay(routeOverlay)
                self.routeOverlay = nil
            }

            if coordinates.count >= 2 {
                let polyline = MKPolyline(coordinates: coordinates, count: coordinates.count)
                routeOverlay = polyline
                mapView.addOverlay(polyline)
            }

            syncStartAnnotation(on: mapView, coordinate: firstCoordinate)
            syncEndAnnotation(on: mapView, coordinates: coordinates)
            return true
        }

        private func syncEndAnnotation(on mapView: MKMapView, coordinates: [CLLocationCoordinate2D]) {
            if let endAnnotation {
                mapView.removeAnnotation(endAnnotation)
                self.endAnnotation = nil
            }
            guard parent.showsEndMarker, coordinates.count >= 2, let last = coordinates.last else { return }
            let annotation = RouteEndpointAnnotation(coordinate: last, isStart: false)
            endAnnotation = annotation
            mapView.addAnnotation(annotation)
        }

        func applyFollowCamera(on mapView: MKMapView, userLocation: CLLocationCoordinate2D?) {
            guard let userLocation else { return }

            let desiredSpan = MKCoordinateSpan(latitudeDelta: 0.005, longitudeDelta: 0.005)
            let centerDistance = distance(from: mapView.centerCoordinate, to: userLocation)
            let needsZoomReset =
                abs(mapView.region.span.latitudeDelta - desiredSpan.latitudeDelta) > 0.001 ||
                abs(mapView.region.span.longitudeDelta - desiredSpan.longitudeDelta) > 0.001

            guard needsZoomReset || centerDistance > 3 else { return }

            applyProgrammaticCameraChange {
                let region = MKCoordinateRegion(center: userLocation, span: desiredSpan)
                if needsZoomReset {
                    mapView.setRegion(region, animated: false)
                } else {
                    mapView.setCenter(userLocation, animated: false)
                }
            }
        }

        func applyOverviewCamera(
            on mapView: MKMapView,
            fallbackCoordinate: CLLocationCoordinate2D?,
            animated: Bool
        ) {
            if let overlay = mapView.overlays.first {
                applyProgrammaticCameraChange {
                    mapView.setVisibleMapRect(
                        overlay.boundingMapRect,
                        edgePadding: parent.overviewPadding,
                        animated: animated
                    )
                }
                return
            }

            guard let fallbackCoordinate else { return }
            applyProgrammaticCameraChange {
                mapView.setRegion(
                    MKCoordinateRegion(
                        center: fallbackCoordinate,
                        span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
                    ),
                    animated: animated
                )
            }
        }

        private func applyProgrammaticCameraChange(_ update: () -> Void) {
            isPerformingProgrammaticCameraChange = true
            update()
        }

        private func syncStartAnnotation(on mapView: MKMapView, coordinate: CLLocationCoordinate2D?) {
            guard let coordinate else {
                if let startAnnotation {
                    mapView.removeAnnotation(startAnnotation)
                    self.startAnnotation = nil
                }
                return
            }

            if let startAnnotation {
                if !coordinatesMatch(startAnnotation.coordinate, coordinate) {
                    startAnnotation.coordinate = coordinate
                }
                return
            }

            let startAnnotation = MKPointAnnotation()
            startAnnotation.coordinate = coordinate
            startAnnotation.title = "Start"
            self.startAnnotation = startAnnotation
            mapView.addAnnotation(startAnnotation)
        }

        private func coordinatesMatch(_ lhs: CLLocationCoordinate2D?, _ rhs: CLLocationCoordinate2D?) -> Bool {
            switch (lhs, rhs) {
            case let (.some(lhs), .some(rhs)):
                return lhs.latitude == rhs.latitude && lhs.longitude == rhs.longitude
            case (nil, nil):
                return true
            default:
                return false
            }
        }

        private func distance(from lhs: CLLocationCoordinate2D, to rhs: CLLocationCoordinate2D) -> CLLocationDistance {
            CLLocation(latitude: lhs.latitude, longitude: lhs.longitude)
                .distance(from: CLLocation(latitude: rhs.latitude, longitude: rhs.longitude))
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let polyline = overlay as? MKPolyline {
                let renderer = MKPolylineRenderer(polyline: polyline)
                renderer.strokeColor = AppConstants.journeyGreenUIColor
                renderer.lineWidth = 4
                renderer.lineCap = .round
                renderer.lineJoin = .round
                return renderer
            }
            return MKOverlayRenderer(overlay: overlay)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKUserLocation { return nil }
            if annotation is RouteEndpointAnnotation {
                let id = "EndMarker"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: id)
                    ?? MKAnnotationView(annotation: annotation, reuseIdentifier: id)
                view.annotation = annotation
                view.image = RouteMarkerImages.end
                return view
            }
            let id = "StartPin"
            var view = mapView.dequeueReusableAnnotationView(withIdentifier: id)
            if view == nil {
                view = MKAnnotationView(annotation: annotation, reuseIdentifier: id)
                let circle = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 14))
                circle.backgroundColor = AppConstants.journeyGreenUIColor
                circle.layer.cornerRadius = 7
                circle.layer.borderWidth = 2
                circle.layer.borderColor = UIColor.white.cgColor
                let renderer = UIGraphicsImageRenderer(size: circle.bounds.size)
                view?.image = renderer.image { ctx in
                    circle.layer.render(in: ctx.cgContext)
                }
                view?.centerOffset = CGPoint(x: 0, y: 0)
            }
            view?.annotation = annotation
            return view
        }

        func mapViewDidFinishRenderingMap(_ mapView: MKMapView, fullyRendered: Bool) {
            parent.onRendered?()
        }

        func mapView(_ mapView: MKMapView, regionWillChangeAnimated animated: Bool) {
            if isUserInteractionDrivingRegionChange(on: mapView) { parent.onUserGesture?() }
            guard !isPerformingProgrammaticCameraChange else { return }
            guard parent.cameraMode != .manual else { return }
            guard !hasPendingManualUnlock else { return }
            guard isUserInteractionDrivingRegionChange(on: mapView) else { return }

            hasPendingManualUnlock = true
            parent.onUserInteraction?()
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            isPerformingProgrammaticCameraChange = false
        }

        private func isUserInteractionDrivingRegionChange(on mapView: MKMapView) -> Bool {
            mapView.subviews.contains { subview in
                (subview.gestureRecognizers ?? []).contains { gestureRecognizer in
                    switch gestureRecognizer.state {
                    case .began, .changed, .ended:
                        return true
                    default:
                        return false
                    }
                }
            }
        }
    }
}
