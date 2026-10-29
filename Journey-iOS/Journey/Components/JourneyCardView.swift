import SwiftUI

/// Photo-first journey card for the journeys list: a miniature of the story page's hero,
/// so tapping it zooms naturally into the full-screen view.
struct JourneyCardView: View {
    static let height: CGFloat = 240
    static let cornerRadius: CGFloat = 24

    let journey: JourneySummary
    let store: JourneyDetailStore

    @State private var photoFailed = false

    private var detail: JourneyDetail? { store.detail(journey.id) }

    /// The first converted photo or video poster. The list's own cover shows until the journey
    /// loads, which then keeps up with uploads and deletes made since the list was fetched.
    private var coverPhoto: String? {
        if let detail { return detail.coverFilename }
        return journey.coverPhoto
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            backdrop

            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0.25),
                    .init(color: .black.opacity(0.55), location: 0.6),
                    .init(color: .black.opacity(0.85), location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            caption
                .padding(18)
        }
        .frame(height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
        .task(id: store.generation) {
            await store.load(journey.id)
        }
        // A new cover, e.g. after the first photo is uploaded or the old one deleted
        .onChange(of: coverPhoto) {
            photoFailed = false
        }
    }

    @ViewBuilder
    private var backdrop: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: "#1E272C"), Color(hex: "#0B0D0E")], startPoint: .top, endPoint: .bottom)

            if let coverPhoto, !photoFailed {
                JourneyPhotoView(filename: coverPhoto, maxPixelSize: 1400) {
                    photoFailed = true
                }
            } else if let detail, detail.routeCoordinates.count >= 2 {
                JourneyRouteSnapshotView(
                    journeyID: journey.id,
                    coordinates: detail.routeCoordinates,
                    // Keep the route clear of the caption
                    insets: UIEdgeInsets(top: 22, left: 28, bottom: Self.height * 0.54, right: 28)
                )
            }
        }
    }

    private var caption: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                JourneyCategoryPill(travelMode: detail?.travelMode ?? journey.travelMode, fontSize: 10)

                if !journey.timeRangeString.isEmpty {
                    Text(journey.timeRangeString)
                        .font(.montserrat(size: 10.5, weight: .medium))
                        .tracking(1)
                        .foregroundStyle(.white.opacity(0.75))
                }
            }

            Text(detail?.name ?? journey.displayName)
                .font(.montserrat(size: 22, weight: .heavy))
                .lineHeight(.exact(points: 25))
                .foregroundStyle(.white)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .shadow(color: .black.opacity(0.25), radius: 10, y: 2)

            JourneyMetadataRow(summary: journey, fontSize: 11)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Gentle press-down feedback for tappable cards.
struct JourneyCardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: configuration.isPressed)
    }
}
