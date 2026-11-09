// Waytracer page for guiding back to a waypoint.

import CoreLocation
import SwiftUI

struct WaytracerPage: View {
    let recorder: JourneyRecorder
    @State private var showsInfo = false
    @State private var createsAfterInfo = false

    var body: some View {
        Group {
            if let waypoint = recorder.waypoint, let location = recorder.location {
                WaypointGuide(location: location, waypoint: waypoint, heading: recorder.heading)
            } else {
                ToolIntro(title: "Waytracer",
                          symbol: "location.circle.fill",
                          actionTitle: "Create Waypoint",
                          actionSymbol: "mappin.and.ellipse",
                          onInfo: { showsInfo = true },
                          onAction: recorder.createWaypoint)
            }
        }
        .pauseOverlay(recorder.isPaused)
        .sheet(isPresented: $showsInfo, onDismiss: createIfRequested) {
            InfoSheet(title: "Worried about finding your way back?", paragraphs: [
                "Waytracer allows you to mark any location and then effortlessly find that spot later through detailed navigation.",
                "For example, you can retrace your steps to a viewpoint you discovered, or mark your vehicle's location before going on a backcountry trek."
            ]) {
                Button {
                    createsAfterInfo = true
                    showsInfo = false
                } label: {
                    IconTitle(title: "Create Waypoint", symbol: "mappin.and.ellipse")
                }
                .buttonStyle(.wide())
            }
        }
    }

    private func createIfRequested() {
        guard createsAfterInfo else { return }
        createsAfterInfo = false
        recorder.createWaypoint()
    }
}

private struct WaypointGuide: View {
    private static let arrivalFeet = 20.0

    let location: CLLocation
    let waypoint: CLLocation
    let heading: Double

    private var feet: Double { location.distance(from: waypoint) * Units.feetPerMeter }
    private var hasArrived: Bool { feet < Self.arrivalFeet }

    var body: some View {
        VStack(spacing: 0) {
            Text(Format.waypointDistance(feet: feet))
                .font(.system(size: 39, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            ZStack {
                if hasArrived {
                    Circle()
                        .fill(.gray.opacity(0.5))
                        .frame(width: 100, height: 100)
                        .scaleEffect(feet / Self.arrivalFeet)
                    Image(systemName: "mappin")
                        .font(.system(size: 60))
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 76, weight: .bold))
                        .foregroundStyle(Theme.accent)
                        .rotationEffect(.degrees(location.bearing(to: waypoint) - heading))
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background((hasArrived ? Color(hex: 0x00A84A) : .black).ignoresSafeArea())
        .animation(.easeInOut(duration: 0.5), value: hasArrived)
    }
}
