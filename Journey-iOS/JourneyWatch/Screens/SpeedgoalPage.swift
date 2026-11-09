// Speedgoal page for timing 0-to-target runs.

import SwiftUI

struct SpeedgoalPage: View {
    private enum Sheet: Identifiable {
        case info, setTarget
        var id: Self { self }
    }

    let recorder: JourneyRecorder
    @State private var sheet: Sheet?

    var body: some View {
        Group {
            if let goal = recorder.speedgoal {
                running(goal)
            } else {
                ToolIntro(title: "Speedgoal",
                          symbol: "gauge.with.needle.fill",
                          actionTitle: "Set Speed",
                          actionSymbol: "speedometer",
                          onInfo: { sheet = .info },
                          onAction: { sheet = .setTarget })
            }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .info: infoSheet
            case .setTarget: SetTargetSheet(recorder: recorder)
            }
        }
    }

    private func running(_ goal: Speedgoal) -> some View {
        VStack(spacing: 0) {
            SpeedGauge(speed: recorder.speed, target: goal.target)
                .containerRelativeFrame(.horizontal) { width, _ in width * 0.64 }
                .padding(.top, 32)
            Spacer(minLength: 0)
            elapsedTime(goal)
                .font(.system(size: 16, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.accent)
                .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topLeading) {
            Button { sheet = .setTarget } label: {
                Image(systemName: "gear").font(.system(size: 18))
            }
            .buttonStyle(.plain)
            .padding(.leading, 14)
            .padding(.top, 14)
        }
        .ignoresSafeArea()
    }

    @ViewBuilder
    private func elapsedTime(_ goal: Speedgoal) -> some View {
        if let hitAfter = goal.hitAfter {
            Text(Format.speedgoalTime(hitAfter, showingHours: true))
        } else if let startedAt = goal.startedAt {
            TimelineView(.animation(minimumInterval: 0.05, paused: recorder.isPaused)) { context in
                Text(Format.speedgoalTime(recorder.activeTime(at: context.date) - startedAt))
            }
        }
    }

    private var infoSheet: some View {
        InfoSheet(title: "What's this?", paragraphs: [
            "Speedgoal lets you set a target speed and times your acceleration until you reach it.",
            "For example, if you want to measure how long it takes to go from 0 to 60 mph, you would set 60 mph as the target. Once movement is detected, the timer automatically starts and continues until you reach 60 mph. This is useful for quantifying acceleration times, athletes tracking sprint starts, or other fitness metrics."
        ]) {
            Button { sheet = .setTarget } label: {
                IconTitle(title: "Set Speed", symbol: "speedometer", tint: Theme.accent)
            }
            .buttonStyle(.wide(Theme.primaryButton))
        }
    }
}

private struct SetTargetSheet: View {
    let recorder: JourneyRecorder
    @Environment(\.dismiss) private var dismiss
    @State private var target = 60
    @State private var isWaitingForFix = false

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                IconTitle(title: "Speedgoal", symbol: "speedometer", tint: Theme.accent)
                    .font(.system(size: 16, weight: .bold))

                Text("Tap and scroll to set your target speed.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.dim)

                Picker("Target Speed", selection: $target) {
                    ForEach(3...1150, id: \.self) { Text("\($0) mph") }
                }
                .pickerStyle(.wheel)
                .labelsHidden()
                .frame(height: 55)

                Button { isWaitingForFix = true } label: {
                    if isWaitingForFix {
                        Text("Setting Speed…").shimmering()
                    } else {
                        IconTitle(title: "Set Speed", symbol: "checkmark.circle")
                    }
                }
                .buttonStyle(.wide())
                .disabled(isWaitingForFix)
            }
            .padding(.horizontal, 8)
        }
        .onAppear { target = recorder.speedgoal?.target ?? target }
        .onChange(of: isWaitingForFix && recorder.hasUsableFix) { _, isReady in
            guard isReady else { return }
            recorder.setSpeedgoal(target: target)
            dismiss()
        }
    }
}
