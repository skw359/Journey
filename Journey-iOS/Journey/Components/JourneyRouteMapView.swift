import SwiftUI
import MapKit

/// Static route map used as a journey backdrop and preview. Touches pass through so the
/// surrounding pager and scroll view keep their gestures; open FullscreenMapScreen to explore.
struct JourneyRouteMapView: UIViewRepresentable {
    let coordinates: [CLLocationCoordinate2D]
    var edgePadding = UIEdgeInsets(top: 40, left: 40, bottom: 40, right: 40)

    func makeUIView(context: Context) -> RouteFittingMapView {
        let mapView = RouteFittingMapView()
        mapView.delegate = context.coordinator
        mapView.isUserInteractionEnabled = false
        mapView.showsUserLocation = false
        mapView.overrideUserInterfaceStyle = .dark

        let config = MKStandardMapConfiguration(emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        config.showsTraffic = false
        mapView.preferredConfiguration = config
        return mapView
    }

    func updateUIView(_ mapView: RouteFittingMapView, context: Context) {
        mapView.edgePadding = edgePadding
        mapView.setRoute(coordinates)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, MKMapViewDelegate {
        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let polyline = overlay as? MKPolyline else { return MKOverlayRenderer(overlay: overlay) }
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = AppConstants.journeyGreenUIColor
            renderer.lineWidth = 4
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            guard let endpoint = annotation as? RouteEndpointAnnotation else { return nil }
            let id = endpoint.isStart ? "RouteStart" : "RouteEnd"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: id)
                ?? MKAnnotationView(annotation: annotation, reuseIdentifier: id)
            view.annotation = annotation
            view.image = endpoint.isStart ? RouteMarkerImages.start : RouteMarkerImages.end
            return view
        }
    }
}

// MARK: - Fitting Map View

/// Keeps the route framed whenever the view's size or padding changes, which SwiftUI
/// only settles after the first layout pass.
final class RouteFittingMapView: MKMapView {
    var edgePadding: UIEdgeInsets = .zero {
        didSet {
            guard edgePadding != oldValue else { return }
            needsFit = true
            setNeedsLayout()
        }
    }

    private var routeLine: MKPolyline?
    private var routeSignature: [Double] = []
    private var needsFit = false
    private var fittedSize: CGSize = .zero

    func setRoute(_ coordinates: [CLLocationCoordinate2D]) {
        let signature = [Double(coordinates.count)] + [coordinates.first, coordinates.last]
            .compactMap { $0 }
            .flatMap { [$0.latitude, $0.longitude] }
        guard signature != routeSignature else { return }
        routeSignature = signature

        removeOverlays(overlays)
        removeAnnotations(annotations)
        routeLine = nil
        guard coordinates.count >= 2, let first = coordinates.first, let last = coordinates.last else { return }

        let line = MKPolyline(coordinates: coordinates, count: coordinates.count)
        addOverlay(line, level: .aboveRoads)
        addAnnotations([
            RouteEndpointAnnotation(coordinate: first, isStart: true),
            RouteEndpointAnnotation(coordinate: last, isStart: false)
        ])

        routeLine = line
        needsFit = true
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedSize { needsFit = true }
        guard needsFit, let routeLine, bounds.width > 1, bounds.height > 1 else { return }
        needsFit = false
        fittedSize = bounds.size
        setVisibleMapRect(paddedRouteRect(routeLine.boundingMapRect), edgePadding: clampedPadding, animated: false)
    }

    /// Short routes would otherwise zoom to street level.
    private func paddedRouteRect(_ rect: MKMapRect) -> MKMapRect {
        let minimumSide = MKMapPointsPerMeterAtLatitude(rect.origin.coordinate.latitude) * 300
        let dx = max(0, minimumSide - rect.width) / 2
        let dy = max(0, minimumSide - rect.height) / 2
        return rect.insetBy(dx: -dx, dy: -dy)
    }

    /// Scales padding down when it would leave no room for the route.
    private var clampedPadding: UIEdgeInsets {
        var padding = edgePadding
        let maxVertical = max(bounds.height - 80, 0)
        if padding.top + padding.bottom > maxVertical {
            let scale = maxVertical / (padding.top + padding.bottom)
            padding.top *= scale
            padding.bottom *= scale
        }
        let maxHorizontal = max(bounds.width - 80, 0)
        if padding.left + padding.right > maxHorizontal {
            let scale = maxHorizontal / (padding.left + padding.right)
            padding.left *= scale
            padding.right *= scale
        }
        return padding
    }
}

// MARK: - Route Markers

final class RouteEndpointAnnotation: NSObject, MKAnnotation {
    let coordinate: CLLocationCoordinate2D
    let isStart: Bool

    init(coordinate: CLLocationCoordinate2D, isStart: Bool) {
        self.coordinate = coordinate
        self.isStart = isStart
    }
}

enum RouteMarkerImages {
    /// Green circle with a white border
    static let start: UIImage = {
        let size: CGFloat = 14
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
            let path = UIBezierPath(ovalIn: CGRect(x: 1, y: 1, width: size - 2, height: size - 2))
            AppConstants.journeyGreenUIColor.setFill()
            path.fill()
            UIColor.white.setStroke()
            path.lineWidth = 2
            path.stroke()
        }
    }()

    /// Red square with a white flag
    static let end: UIImage = {
        let size: CGFloat = 28
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
            UIColor(red: 255/255, green: 59/255, blue: 48/255, alpha: 1).setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: size, height: size), cornerRadius: 4).fill()

            let config = UIImage.SymbolConfiguration(pointSize: 14, weight: .bold)
            if let flag = UIImage(systemName: "flag.fill", withConfiguration: config)?
                .withTintColor(.white, renderingMode: .alwaysOriginal) {
                flag.draw(in: CGRect(
                    x: (size - flag.size.width) / 2,
                    y: (size - flag.size.height) / 2,
                    width: flag.size.width,
                    height: flag.size.height
                ))
            }
        }
    }()
}
