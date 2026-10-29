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

struct LiveMapView: UIViewRepresentable {
    let coordinates: [CLLocationCoordinate2D]
    let userLocation: CLLocationCoordinate2D?
    let cameraMode: LiveMapCameraMode
    let mapStyle: LiveMapStyle
    let isRecording: Bool
    var onUserInteraction: (() -> Void)? = nil

    func makeUIView(context: Context) -> MKMapView {
        let mapView = MKMapView()
        mapView.delegate = context.coordinator
        mapView.showsUserLocation = true
        mapView.isZoomEnabled = true
        mapView.isScrollEnabled = true
        mapView.isRotateEnabled = true
        mapView.overrideUserInterfaceStyle = .dark
        mapView.layer.cornerRadius = 16
        mapView.clipsToBounds = true
        context.coordinator.applyMapStyle(on: mapView, style: mapStyle)
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.applyMapStyle(on: mapView, style: mapStyle)

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
            if routeDidChange || context.coordinator.lastCameraMode != .overview {
                context.coordinator.applyOverviewCamera(
                    on: mapView,
                    fallbackCoordinate: coordinates.first ?? userLocation,
                    animated: false
                )
            }
        case .manual:
            if !context.coordinator.hasShownInitialRegion {
                context.coordinator.hasShownInitialRegion = true
                context.coordinator.applyOverviewCamera(
                    on: mapView,
                    fallbackCoordinate: coordinates.first ?? userLocation,
                    animated: false
                )
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
        private var renderedCoordinateCount = 0
        private var renderedFirstCoordinate: CLLocationCoordinate2D?
        private var renderedLastCoordinate: CLLocationCoordinate2D?

        init(parent: LiveMapView) {
            self.parent = parent
        }

        func applyMapStyle(on mapView: MKMapView, style: LiveMapStyle) {
            guard lastMapStyle != style else { return }

            mapView.mapType = style.mapType
            mapView.pointOfInterestFilter = .excludingAll
            mapView.showsTraffic = false
            lastMapStyle = style
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
            return true
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
                        edgePadding: UIEdgeInsets(top: 48, left: 32, bottom: 48, right: 32),
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

        func mapView(_ mapView: MKMapView, regionWillChangeAnimated animated: Bool) {
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
