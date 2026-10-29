import SwiftUI

struct StartStopButton: View {
    let isRecording: Bool
    let action: () -> Void

    private var accent: Color {
        isRecording ? AppConstants.redAction : AppConstants.journeyGreen
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: isRecording ? "stop.fill" : "play.fill")
                    .font(.system(size: 18, weight: .bold))

                Text(isRecording ? "Stop" : "Start")
                    .font(.montserrat(size: 20, weight: .bold))
                    .tracking(2.5)
            }
            .foregroundColor(accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 22)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(isRecording ? Color(hex: "#2A0000") : Color(hex: "#002211"))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(accent.opacity(0.55), lineWidth: 1)
                    )
                    .shadow(color: accent.opacity(0.35), radius: 18, x: 0, y: 6)
            )
        }
        .animation(.easeInOut(duration: 0.2), value: isRecording)
    }
}
