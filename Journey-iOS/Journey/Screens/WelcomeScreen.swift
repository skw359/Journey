// First-launch welcome and pairing screen.

import SwiftUI
import UIKit

struct WelcomeScreen: View {
    @Environment(PairingManager.self) private var pairingManager

    @State private var displayedText = ""
    @State private var textOpacity = 0.0
    @State private var yOffset: CGFloat = 20
    @State private var panelShown = false
    @State private var hasStartedTypingAnimation = false
    @State private var typingAnimationCompleted = false
    @State private var showQRScanner = false
    @State private var isPairingAfterScan = false
    @State private var showRejectedCodeAlert = false

    private enum AnimationPhase {
        case typingJourney
        case deletingJourney
        case typingTagline
        case done
    }
    @State private var phase: AnimationPhase = .typingJourney

    let welcomeTypingDuration: Double = 0.7
    let animationDuration: Double = 0.7
    let fadeDuration: Double = 0.7

    private let baseText = "Welcome to "
    private let journeyWord = "Journey."
    private let tagline = "the first-class timeline platform."
    private let firstClassRange = (4, 15)

    private let green = Color(hex: "#00d67e")

    private var textSegments: [(String, Color)] {
        switch phase {
        case .typingJourney, .deletingJourney:
            let len = displayedText.count
            let baselen = baseText.count
            if len <= baselen {
                return displayedText.isEmpty ? [] : [(displayedText, .white)]
            }
            let journeyPart = String(displayedText.dropFirst(baselen))
            return [(baseText, .white), (journeyPart, green)]

        case .typingTagline, .done:
            let taglinePart = String(displayedText.dropFirst(baseText.count))
            return [(baseText, .white)] + taglineSegments(typed: taglinePart)
        }
    }

    private var attributedTagline: AttributedString {
        var result = AttributedString()
        for (text, color) in textSegments {
            var piece = AttributedString(text)
            piece.foregroundColor = color
            result.append(piece)
        }
        return result
    }

    private func taglineSegments(typed: String) -> [(String, Color)] {
        let lo = firstClassRange.0
        let hi = firstClassRange.1
        let len = typed.count

        var segments: [(String, Color)] = []

        if len <= lo {
            segments.append((typed, .white))
        } else if len <= hi {
            let before = String(typed.prefix(lo))
            let colored = String(typed.dropFirst(lo))
            if !before.isEmpty { segments.append((before, .white)) }
            if !colored.isEmpty { segments.append((colored, green)) }
        } else {
            let before = String(typed.prefix(lo))
            let colored = String(typed.prefix(hi).dropFirst(lo))
            let after = String(typed.dropFirst(hi))
            if !before.isEmpty { segments.append((before, .white)) }
            if !colored.isEmpty { segments.append((colored, green)) }
            if !after.isEmpty { segments.append((after, .white)) }
        }

        return segments
    }

    var body: some View {
        GeometryReader { geometry in
            let height = geometry.size.height
            let panelTopWhenShown = height / 1.4
            let panelOffset = panelShown ? panelTopWhenShown : height + 10

            ZStack {
                if isPairingAfterScan {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(green)
                        .scaleEffect(1.4)
                } else {
                    VStack {
                        Spacer()

                        Text(attributedTagline)
                            .font(.montserrat(size: 30, weight: .bold))
                            .padding()
                            .opacity(textOpacity)
                            .offset(y: yOffset)
                            .animation(.easeOut(duration: fadeDuration), value: textOpacity)
                            .animation(.easeOut(duration: fadeDuration), value: yOffset)

                        Spacer()
                    }
                    .padding(.bottom, max(0, height - panelOffset))
                    .animation(.spring(), value: panelShown)

                    VStack(spacing: 16) {
                        HStack {
                            Image(systemName: "qrcode.viewfinder")
                                .foregroundColor(green)
                            Text("Pair Your Device")
                                .font(.montserrat(size: 17, weight: .bold))
                                .foregroundColor(.white)
                        }

                        Button {
                            showQRScanner = true
                        } label: {
                            Text("Scan QR Code")
                                .font(.montserrat(size: 17, weight: .bold))
                                .foregroundColor(.white)
                                .padding()
                                .frame(width: 300)
                                .background(
                                    RoundedRectangle(cornerRadius: 10)
                                        .strokeBorder(Color(hex: "#2c2c2e"), lineWidth: 2)
                                )
                        }
                        .buttonStyle(.plain)

                        Text("Open your Journey web dashboard and scan the pairing QR code.")
                            .frame(width: 300)
                            .padding()
                            .font(.montserrat(size: 14, weight: .bold))
                            .foregroundColor(Color(hex: "#3A3A3C"))

                        Spacer()
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
                    .background(
                        RoundedRectangle(cornerRadius: 30)
                            .fill(Color.black.opacity(0.8))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 30)
                            .stroke(green, lineWidth: 1)
                    )
                    .cornerRadius(30)
                    .offset(y: panelOffset)
                    .animation(.spring(), value: panelShown)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
        }
        .edgesIgnoringSafeArea(.all)
        .onAppear {
            startTypingAnimationIfNeeded()
            if !typingAnimationCompleted {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    panelShown = true
                }
            }
        }
        .sheet(isPresented: $showQRScanner) {
            QRScannerView { code in
                isPairingAfterScan = true
                showQRScanner = false
                guard let parsed = pairingManager.parseQRCode(code) else {
                    isPairingAfterScan = false
                    return
                }

                Task {
                    await Task.yield()
                    let didPair = await pairingManager.pair(serverURL: parsed.server, token: parsed.token)
                    if !didPair {
                        await MainActor.run {
                            isPairingAfterScan = false
                            showRejectedCodeAlert = true
                        }
                    }
                }
            }
        }
        .alert("Couldn't pair", isPresented: $showRejectedCodeAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(PairingManager.rejectedCodeMessage)
        }
    }

    private func startTypingAnimationIfNeeded() {
        guard !hasStartedTypingAnimation else { return }
        hasStartedTypingAnimation = true

        Task {
            await runTypingAnimation()
        }
    }

    @MainActor
    private func runTypingAnimation() async {
        displayedText = ""
        phase = .typingJourney
        let typingFeedbackGenerator = UISelectionFeedbackGenerator()
        typingFeedbackGenerator.prepare()

        withAnimation {
            textOpacity = 1.0
            yOffset = 0
        }

        await appendText(
            baseText + journeyWord,
            duration: welcomeTypingDuration,
            feedbackGenerator: typingFeedbackGenerator
        )

        guard !(await sleep(seconds: 1.5)) else { return }
        await deleteJourney()
    }

    @MainActor
    private func deleteJourney() async {
        phase = .deletingJourney
        let deleteInterval = animationDuration / Double(max(journeyWord.count, 1))

        while displayedText.count > baseText.count {
            displayedText.removeLast()

            if await sleep(seconds: deleteInterval) {
                return
            }
        }

        await typeTagline()
    }

    @MainActor
    private func typeTagline() async {
        phase = .typingTagline
        await appendText(tagline, duration: 2.0)
        phase = .done
        typingAnimationCompleted = true
    }

    @MainActor
    private func appendText(
        _ text: String,
        duration: Double,
        feedbackGenerator: UISelectionFeedbackGenerator? = nil
    ) async {
        let characters = Array(text)
        let interval = duration / Double(max(characters.count, 1))

        for character in characters {
            displayedText.append(character)
            if character.isLetter {
                feedbackGenerator?.selectionChanged()
                feedbackGenerator?.prepare()
            }

            if await sleep(seconds: interval) {
                return
            }
        }
    }

    private func sleep(seconds: Double) async -> Bool {
        guard seconds > 0 else { return false }

        do {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return false
        } catch {
            return true
        }
    }
}
