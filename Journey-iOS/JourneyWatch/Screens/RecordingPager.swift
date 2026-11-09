// Swipeable pages shown while recording.

import SwiftUI
import WatchKit

enum RecordingPage: Int {
    case nowPlaying = -3, speedgoal = -2, waytracer = -1, compass = 0, recording = 1, options = 3
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
            tab("Stop Recording", .options) { OptionsPage(recorder: recorder, page: $page) }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .toolbar(.hidden, for: .navigationBar)
        .fullScreenCover(isPresented: $recorder.isCreatingWaypoint) { CreatingWaypointView() }
        .onChange(of: recorder.waypoint) { _, waypoint in
            if waypoint != nil { withAnimation { page = .waytracer } }
        }
        .onChange(of: page, initial: true) { _, page in
            recorder.usesHeading = page == .compass || page == .waytracer
        }
    }

    private func tab<Content: View>(_ title: String, _ page: RecordingPage, @ViewBuilder content: () -> Content) -> some View {
        ZStack { content() }
            .tabItem { Text(title) }
            .tag(page)
    }
}
