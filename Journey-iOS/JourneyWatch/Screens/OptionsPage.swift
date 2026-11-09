// Options page with water lock, waypoint and end buttons.

import SwiftUI
import WatchKit

struct OptionsPage: View {
    let recorder: JourneyRecorder
    @Binding var page: RecordingPage

    var body: some View {
        Grid(horizontalSpacing: 8, verticalSpacing: 6) {
            GridRow {
                OptionButton(title: "Lock", symbol: "drop.degreesign.fill", tint: Color(hex: 0x44D7B6), background: Color(hex: 0x292929), isRound: true) {
                    WKInterfaceDevice.current().enableWaterLock()
                    withAnimation { page = .recording }
                }
                .dimmedWhilePaused(recorder.isPaused)

                OptionButton(title: "Waypoint", symbol: "mappin.and.ellipse", tint: Color(hex: 0x34D34B), background: Color(hex: 0x292929), isRound: true, action: recorder.createWaypoint)
                    .dimmedWhilePaused(recorder.isPaused)
            }
            GridRow {
                OptionButton(title: "End", symbol: "xmark", tint: Color(hex: 0xFF2727), background: Color(hex: 0x220100), action: recorder.end)

                OptionButton(title: recorder.isPaused ? "Resume" : "Pause",
                             symbol: recorder.isPaused ? "play.fill" : "pause.fill",
                             tint: recorder.isPaused ? Color(hex: 0x46FF40) : Color(hex: 0xFFD700),
                             background: recorder.isPaused ? Color(hex: 0x0F360D) : Color(hex: 0x2B2917)) {
                    withAnimation(.easeInOut(duration: 0.15)) { recorder.togglePause() }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
        .ignoresSafeArea(edges: .bottom)
    }
}

private struct OptionButton: View {
    let title: String
    let symbol: String
    let tint: Color
    let background: Color
    var isRound = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                icon
                Text(title)
                    .font(.system(size: 12))
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var icon: some View {
        let image = Image(systemName: symbol)
            .font(.system(size: 24))
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        if isRound {
            image
                .background(background, in: .circle)
                .aspectRatio(1, contentMode: .fit)
        } else {
            image.background(background, in: .rect(cornerRadius: 14))
        }
    }
}

private extension View {
    func dimmedWhilePaused(_ isPaused: Bool) -> some View {
        disabled(isPaused).opacity(isPaused ? 0.2 : 1)
    }
}
