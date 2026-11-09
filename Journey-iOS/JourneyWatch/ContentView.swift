// Switches the watch app between welcome, idle, recording and the trip summary.

import SwiftUI

struct ContentView: View {
    @State private var recorder = JourneyRecorder()
    @AppStorage("hasSeenWelcome") private var hasSeenWelcome = false

    var body: some View {
        @Bindable var recorder = recorder
        NavigationStack {
            Group {
                if !hasSeenWelcome {
                    WelcomeScreen { hasSeenWelcome = true }
                } else if recorder.isRecording {
                    RecordingPager(recorder: recorder)
                } else {
                    StartScreen(recorder: recorder)
                }
            }
            .navigationDestination(item: $recorder.finishedTrip) { TravelRecordedScreen(trip: $0) }
        }
        .overlay {
            if recorder.isProcessing {
                ProcessingView().transition(.move(edge: .bottom))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: recorder.isProcessing)
        .task { recorder.prepare() }
    }
}
