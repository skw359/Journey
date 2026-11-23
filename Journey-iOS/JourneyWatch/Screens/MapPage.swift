// Live map page showing the route so far and the current position.

import MapKit
import SwiftUI

struct MapPage: View {
    let recorder: JourneyRecorder
    @Binding var page: RecordingPage
    /// The map is created the first time this page is opened and then kept for the rest of
    /// the trip. Rebuilding it on every visit costs more memory than it gives back.
    @State private var hasOpened = false
    @Environment(\.isLuminanceReduced) private var isDimmed
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let isSelected = page == .map
        let isLive = isSelected && !isDimmed && scenePhase == .active
        ZStack {
            if hasOpened {
                RouteMap(route: isLive ? recorder.route : nil)
                    .equatable()
            } else {
                Image(systemName: "map.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Theme.dim)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .pauseOverlay(recorder.isPaused)
        .onChange(of: isSelected, initial: true) {
            if isSelected { hasOpened = true }
        }
    }
}

private struct RouteMap: View, Equatable {
    private static let followSpan: CLLocationDistance = 500
    private static let recenterDistance: CLLocationDistance = 60

    /// The route to draw, or nil to leave the map exactly as it is. It is nil while the page
    /// is off screen or the wrist is down, so nothing is redrawn until someone is looking.
    let route: RouteTrack?
    @State private var camera = MapCameraPosition.automatic
    @State private var center: CLLocationCoordinate2D?
    @State private var showsWholeRoute = false

    static func == (shown: RouteMap, next: RouteMap) -> Bool {
        next.route == nil || shown.route?.revision == next.route?.revision
    }

    var body: some View {
        let coordinates = route?.coordinates ?? []
        Map(position: $camera, interactionModes: []) {
            if coordinates.count > 1 {
                MapPolyline(coordinates: coordinates)
                    .stroke(Theme.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
            }
            if let position = coordinates.last {
                Annotation("", coordinate: position) { PositionDot() }
                    .annotationTitles(.hidden)
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll, showsTraffic: false))
        .mapControlVisibility(.hidden)
        .allowsHitTesting(false)
        .ignoresSafeArea()
        .overlay(alignment: .bottomTrailing) { viewButton }
        .onChange(of: route?.revision, initial: true) { follow() }
    }

    private var viewButton: some View {
        Button {
            showsWholeRoute.toggle()
            center = nil
            withAnimation {
                if showsWholeRoute { camera = .automatic } else { follow() }
            }
        } label: {
            Image(systemName: showsWholeRoute ? "location.fill" : "point.topleft.down.to.point.bottomright.curvepath")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(width: 36, height: 36)
                .background(Color(hex: 0x292929), in: .circle)
        }
        .buttonStyle(.plain)
        .padding(6)
        .accessibilityLabel(showsWholeRoute ? "Follow my position" : "Show whole route")
    }

    /// Moves the camera only once the position has drifted well off center, and jumps rather
    /// than glides. Each camera move redraws the whole map, which is what costs battery.
    private func follow() {
        guard !showsWholeRoute, let position = route?.last else { return }
        if let center, center.distance(to: position) < Self.recenterDistance { return }
        center = position
        camera = .region(MKCoordinateRegion(center: position,
                                            latitudinalMeters: Self.followSpan,
                                            longitudinalMeters: Self.followSpan))
    }
}

private struct PositionDot: View {
    var body: some View {
        Circle()
            .fill(Theme.accent)
            .stroke(.white, lineWidth: 2)
            .frame(width: 14, height: 14)
    }
}
