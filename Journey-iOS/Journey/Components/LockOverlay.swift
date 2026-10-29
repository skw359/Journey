import SwiftUI

struct LockOverlay: View {
    @Binding var isLocked: Bool
    @Environment(LocationService.self) private var locationService

    @State private var dragOffset: CGFloat = 0
    @State private var sliderWidth: CGFloat = 0

    private let sliderHeight: CGFloat = 64
    private let knobSize: CGFloat = 52
    private let knobPadding: CGFloat = 6
    private let unlockThreshold: CGFloat = 0.75

    var body: some View {
        if isLocked {
            ZStack {
                Color.black.ignoresSafeArea()

                VStack(spacing: 20) {
                    Spacer()

                    // App icon and name
                    HStack(spacing: 10) {
                        // Three vertical bars icon
                        HStack(spacing: 3) {
                            ForEach(0..<3, id: \.self) { _ in
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(AppConstants.journeyGreen)
                                    .frame(width: 6, height: 22)
                            }
                        }
                        Text("JOURNEY")
                            .font(.montserrat(size: 22, weight: .bold))
                            .foregroundColor(.white)
                            .tracking(2)
                    }

                    // Duration
                    Text(DurationFormatter.format(locationService.totalSeconds))
                        .font(.montserrat(size: 64, weight: .bold))
                        .foregroundColor(.white)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(.default, value: locationService.totalSeconds)

                    Spacer()

                    // Slide to unlock
                    GeometryReader { geo in
                        let maxDrag = geo.size.width - knobSize - knobPadding * 2

                        ZStack(alignment: .leading) {
                            // Track background
                            Capsule()
                                .fill(AppConstants.darkCardBackground)
                                .overlay(
                                    Capsule()
                                        .stroke(AppConstants.darkCardBorder, lineWidth: 1)
                                )

                            // Label
                            Text("Slide to unlock")
                                .font(.montserrat(size: 16, weight: .medium))
                                .foregroundColor(Color(hex: "#3A3A3C"))
                                .frame(maxWidth: .infinity)
                                .opacity(1.0 - Double(dragOffset / maxDrag))

                            // Knob
                            Circle()
                                .fill(.white)
                                .frame(width: knobSize, height: knobSize)
                                .overlay(
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 18, weight: .semibold))
                                        .foregroundColor(.gray)
                                )
                                .offset(x: knobPadding + dragOffset)
                                .gesture(
                                    DragGesture()
                                        .onChanged { value in
                                            dragOffset = min(max(0, value.translation.width), maxDrag)
                                        }
                                        .onEnded { _ in
                                            if dragOffset > maxDrag * unlockThreshold {
                                                withAnimation(.easeOut(duration: 0.2)) {
                                                    dragOffset = maxDrag
                                                }
                                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                                                    withAnimation { isLocked = false }
                                                    dragOffset = 0
                                                }
                                            } else {
                                                withAnimation(.spring(response: 0.4, dampingFraction: 0.7)) {
                                                    dragOffset = 0
                                                }
                                            }
                                        }
                                )
                        }
                        .frame(height: sliderHeight)
                        .onAppear { sliderWidth = geo.size.width }
                    }
                    .frame(height: sliderHeight)
                    .padding(.horizontal, 40)
                    .padding(.bottom, 60)
                }
            }
            .statusBarHidden(true)
        }
    }
}
