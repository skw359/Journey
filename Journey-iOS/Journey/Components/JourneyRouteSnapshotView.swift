import SwiftUI
import MapKit

/// A rendered image of a journey's route on the dark map. Used instead of a live MKMapView for
/// non-interactive maps (list cards, story heroes and previews): creating map views stalls the
/// main thread, which would stutter list scrolling and the story pager.
struct JourneyRouteSnapshotView: View {
    let journeyID: String
    let coordinates: [CLLocationCoordinate2D]
    /// Space kept clear around the route, e.g. for overlaid text.
    var insets = UIEdgeInsets(top: 40, left: 40, bottom: 40, right: 40)
    var lineWidth: CGFloat = 3.5

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { geometry in
            let request = RouteSnapshotRequest(journeyID: journeyID, size: geometry.size, insets: insets, lineWidth: lineWidth)
            let shown = image ?? RouteSnapshotCache.shared.cachedImage(for: request)

            Color.clear
                .overlay {
                    if let shown {
                        Image(uiImage: shown)
                            .resizable()
                            .transition(.opacity)
                    }
                }
                .task(id: TaskID(request: request, pointCount: coordinates.count)) {
                    let size = request.size
                    guard shown == nil, size.width > 0, size.height > 0, coordinates.count >= 2 else { return }
                    let rendered = await RouteSnapshotCache.shared.image(for: request, coordinates: coordinates, scale: displayScale)
                    guard !Task.isCancelled else { return }
                    withAnimation(.easeOut(duration: 0.35)) { image = rendered }
                }
        }
    }

    private struct TaskID: Equatable {
        let request: RouteSnapshotRequest
        let pointCount: Int
    }
}

struct RouteSnapshotRequest: Equatable {
    let journeyID: String
    let size: CGSize
    let insets: UIEdgeInsets
    let lineWidth: CGFloat

    fileprivate var cacheKey: NSString {
        let padding = [insets.top, insets.left, insets.bottom, insets.right].map { String(Int($0)) }.joined(separator: ",")
        return "\(journeyID)@\(Int(size.width))x\(Int(size.height))[\(padding)]\(lineWidth)" as NSString
    }
}

// MARK: - Snapshot Cache

final class RouteSnapshotCache {
    static let shared = RouteSnapshotCache()

    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [NSString: Task<UIImage?, Never>] = [:]

    private init() {
        cache.totalCostLimit = 60 * 1024 * 1024
    }

    func cachedImage(for request: RouteSnapshotRequest) -> UIImage? {
        cache.object(forKey: request.cacheKey)
    }

    func image(for request: RouteSnapshotRequest, coordinates: [CLLocationCoordinate2D], scale: CGFloat) async -> UIImage? {
        let key = request.cacheKey
        if let cached = cache.object(forKey: key) { return cached }
        if let pending = inFlight[key] { return await pending.value }

        let style = RouteStyle(
            lineWidth: request.lineWidth,
            lineColor: AppConstants.journeyGreenUIColor,
            startMarker: RouteMarkerImages.start,
            endMarker: RouteMarkerImages.end
        )
        let task = Task<UIImage?, Never> {
            await Self.render(coordinates: coordinates, size: request.size, scale: scale, insets: request.insets, style: style)
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil

        if let image, let cgImage = image.cgImage {
            cache.setObject(image, forKey: key, cost: cgImage.bytesPerRow * cgImage.height)
        }
        return image
    }

    private nonisolated struct RouteStyle: Sendable {
        let lineWidth: CGFloat
        let lineColor: UIColor
        let startMarker: UIImage
        let endMarker: UIImage
    }

    /// Runs off the main actor: drawing a full-screen route image takes long enough to drop frames.
    @concurrent
    private nonisolated static func render(
        coordinates: [CLLocationCoordinate2D],
        size: CGSize,
        scale: CGFloat,
        insets: UIEdgeInsets,
        style: RouteStyle
    ) async -> UIImage? {
        let options = MKMapSnapshotter.Options()
        options.mapRect = mapRect(fitting: coordinates, in: size, insets: insets)
        options.size = size
        options.traitCollection = UITraitCollection { traits in
            traits.userInterfaceStyle = .dark
            traits.displayScale = scale
        }
        let config = MKStandardMapConfiguration(emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        options.preferredConfiguration = config

        guard let snapshot = try? await MKMapSnapshotter(options: options).start() else { return nil }

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            snapshot.image.draw(at: .zero)

            let points = coordinates.map { snapshot.point(for: $0) }
            let path = UIBezierPath()
            path.move(to: points[0])
            points.dropFirst().forEach { path.addLine(to: $0) }
            path.lineCapStyle = .round
            path.lineJoinStyle = .round

            style.lineColor.setStroke()
            path.lineWidth = style.lineWidth
            path.stroke()

            for (marker, point) in [(style.startMarker, points[0]), (style.endMarker, points[points.count - 1])] {
                marker.draw(at: CGPoint(x: point.x - marker.size.width / 2, y: point.y - marker.size.height / 2))
            }
        }
    }

    /// The map area that puts the route inside `size` minus `insets`.
    private nonisolated static func mapRect(fitting coordinates: [CLLocationCoordinate2D], in size: CGSize, insets: UIEdgeInsets) -> MKMapRect {
        var route = MKPolyline(coordinates: coordinates, count: coordinates.count).boundingMapRect

        // Short routes would otherwise zoom to street level
        let minimumSide = MKMapPointsPerMeterAtLatitude(coordinates[0].latitude) * 300
        route = route.insetBy(dx: -max(0, minimumSide - route.width) / 2, dy: -max(0, minimumSide - route.height) / 2)

        let available = CGSize(
            width: max(size.width - insets.left - insets.right, 1),
            height: max(size.height - insets.top - insets.bottom, 1)
        )
        let mapPointsPerPoint = max(route.width / available.width, route.height / available.height)
        let center = CGPoint(x: insets.left + available.width / 2, y: insets.top + available.height / 2)

        return MKMapRect(
            x: route.midX - center.x * mapPointsPerPoint,
            y: route.midY - center.y * mapPointsPerPoint,
            width: size.width * mapPointsPerPoint,
            height: size.height * mapPointsPerPoint
        )
    }
}
