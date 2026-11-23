// Swipeable pages shown while recording.

import SwiftUI
import WatchKit

enum RecordingPage: Int {
    case nowPlaying = -3, speedgoal = -2, waytracer = -1, compass = 0, recording = 1, map = 2, options = 3
}

struct RecordingPager: View {
    let recorder: JourneyRecorder
    @State private var page = RecordingPage.recording

    var body: some View {
        @Bindable var recorder = recorder
        TabView(selection: $page) {
            tab("Now Playing", .nowPlaying) { NowPlayingView() }
            tab("Target Speed", .speedgoal) { SpeedgoalPage(recorder: recorder) }
            tab("Waypoint", .waytracer) { WaytracerPage(recorder: recorder) }
            tab("Compass", .compass) { CompassPage(recorder: recorder) }
            tab("Recording", .recording) { RecordingStatsPage(recorder: recorder) }
            tab("Map", .map) { MapPage(recorder: recorder, page: $page) }
            tab("Stop Recording", .options) { OptionsPage(recorder: recorder, page: $page) }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .toolbar(.hidden, for: .navigationBar)
        .fullScreenCover(isPresented: $recorder.isCreatingWaypoint) { CreatingWaypointView() }
        .onChange(of: recorder.waypoint) { _, waypoint in
            if waypoint != nil { withAnimation { page = .waytracer } }
        }
        .background { HeadingSwitch(recorder: recorder, page: $page) }
    }

    private func tab<Content: View>(_ title: String, _ page: RecordingPage, @ViewBuilder content: () -> Content) -> some View {
        ZStack { content() }
            .tabItem { Text(title) }
            .tag(page)
    }
}

/// Reads the current page in a view of its own. Reading it in RecordingPager's body rebuilds
/// the whole TabView on every swipe, and SwiftUI keeps each old copy in memory.
private struct HeadingSwitch: View {
    let recorder: JourneyRecorder
    @Binding var page: RecordingPage

    var body: some View {
        Color.clear.onChange(of: page, initial: true) { _, page in
            recorder.usesHeading = page == .compass || page == .waytracer
        }
    }
}
