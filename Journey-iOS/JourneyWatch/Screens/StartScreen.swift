// Idle screen with the start button, GPS status and settings.

import SwiftUI

struct StartScreen: View {
    let recorder: JourneyRecorder
    @State private var showsSettings = false
    @State private var showsIndoorInfo = false

    var body: some View {
        VStack(spacing: 0) {
            Button { showsSettings = true } label: {
                Image(systemName: "gear").font(.title2)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)

            Spacer(minLength: 0)

            Button(action: recorder.start) {
                HStack(spacing: 8) {
                    Image(systemName: "circle.fill")
                        .foregroundStyle(recorder.hasFix ? Theme.accent : Theme.dim)
                    ViewThatFits(in: .horizontal) {
                        Text(recorder.hasFix ? "Record Journey" : "Searching GPS")
                        Text(recorder.hasFix ? "Record" : "Searching")
                    }
                    .foregroundStyle(recorder.hasFix ? .white : Theme.dim)
                }
            }
            .buttonStyle(.wide(recorder.hasFix ? Theme.primaryButton : Theme.secondaryButton))
            .disabled(!recorder.hasFix)

            Spacer(minLength: 0)

            Button { showsIndoorInfo = true } label: {
                HStack(spacing: 4) {
                    Image(systemName: "info.circle").foregroundStyle(Theme.caption)
                    Text("Don't use indoors.")
                }
                .font(.system(size: 12))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.top, 10)
        .padding(.bottom, 36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showsSettings) { SettingsSheet() }
        .sheet(isPresented: $showsIndoorInfo) {
            InfoSheet(title: "Why can't Journey be used indoors?", paragraphs: [
                "Journey relies on satellite signals to accurately track your location and movements. When indoors, these signals can be significantly weakened or blocked by buildings and other structures, leading to inaccurate or no location data.",
                "For the best experience and most accurate tracking:",
                "• Use the app outdoors.",
                "• Avoid areas with tall buildings or dense tree cover",
                "• Allow a few moments for GPS signal acquisition",
                "Using the app indoors may result in incomplete or inaccurate data."
            ]) { EmptyView() }
        }
    }
}

private struct SettingsSheet: View {
    @AppStorage("usePreciseUnits") private var usePreciseUnits = false

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("Settings").font(.headline)
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("Use Precise Units", isOn: $usePreciseUnits)
                        .toggleStyle(.switch)
                    Text("Display values with two decimal places.")
                        .font(.caption2)
                        .foregroundStyle(Theme.dim)
                }
                .padding(10)
                .background(Color(hex: 0x1C1C1E), in: .rect(cornerRadius: 12))
            }
            .padding(.horizontal, 8)
        }
    }
}
