// Settings screen.

import SwiftUI

struct SettingsScreen: View {
    @Environment(PairingManager.self) private var pairingManager
    @Environment(UploadManager.self) private var uploadManager
    @Binding var showUploads: Bool

    @AppStorage(AppConstants.confirmBeforeStoppingKey) private var confirmBeforeStopping = true
    @AppStorage(AppConstants.autoSegmentKey) private var autoSegmentJourneys = false
    @AppStorage(AppConstants.appearanceKey) private var appearance = "dark"
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    @State private var showQRScanner = false
    @State private var showDisconnectAlert = false
    @State private var showRejectedCodeAlert = false
    @State private var userProfile: APIService.Profile?
    @State private var scrollPosition = ScrollPosition()

    private static let uploadsSectionID = "uploads"

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 24) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Settings")
                            .font(.montserrat(size: 28, weight: .heavy))
                            .foregroundColor(.white)
                            .accessibilityAddTraits(.isHeader)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if let profile = userProfile {
                        ProfileHeaderView(profile: profile)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        SettingsSectionHeader(title: "Recording")

                        SettingsSection {
                            SettingsToggle(
                                icon: "exclamationmark.circle.fill",
                                iconColor: AppConstants.journeyGreen,
                                label: "Confirm before stopping",
                                isOn: $confirmBeforeStopping
                            )
                            SettingsDivider()
                            SettingsToggle(
                                icon: "tuningfork",
                                iconColor: AppConstants.journeyGreen,
                                label: "Auto-segment journeys",
                                isOn: $autoSegmentJourneys
                            )
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        SettingsSectionHeader(title: "Units")

                        SettingsSection {
                            SettingsToggle(
                                icon: "ruler.fill",
                                iconColor: AppConstants.journeyGreen,
                                label: "Metric units",
                                detail: useMetricUnits ? "Showing km, km/h, m, and m/s²." : "Showing mi, mph, ft, and ft/s².",
                                isOn: $useMetricUnits
                            )
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        SettingsSectionHeader(title: "Server Pairing")

                        SettingsSection {
                            VStack(alignment: .leading, spacing: 16) {
                                ViewThatFits(in: .horizontal) {
                                    HStack(spacing: 8) { pairingStatus }
                                    VStack(alignment: .leading, spacing: 8) { pairingStatus }
                                }

                                ViewThatFits(in: .horizontal) {
                                    HStack(spacing: 10) { pairingButtons }
                                    VStack(spacing: 10) { pairingButtons }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            SettingsSectionHeader(title: "Uploads")
                            Spacer()
                            Menu {
                                Button("Upload All") {
                                    Task { await uploadManager.uploadAll() }
                                }
                                Button("Retry Failed") {
                                    Task { await uploadManager.retryFailed() }
                                }
                                Button("Clear Completed") {
                                    uploadManager.clearCompleted()
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(.white.opacity(0.7))
                                    .frame(width: 36, height: 36)
                                    .background(Circle().fill(Color.white.opacity(0.08)))
                            }
                            .accessibilityLabel("Upload Actions")
                        }

                        if uploadManager.queue.isEmpty {
                            SettingsSection {
                                Text("All caught up")
                                    .font(.montserrat(size: 14))
                                    .foregroundColor(.gray)
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .padding(.vertical, 8)
                            }
                        } else {
                            SettingsSection {
                                VStack(spacing: 0) {
                                    ForEach(Array(uploadManager.queue.enumerated()), id: \.element.id) { index, item in
                                        UploadQueueRow(item: item) {
                                            Task { _ = await uploadManager.upload(item: item) }
                                        }
                                        if index < uploadManager.queue.count - 1 {
                                            SettingsDivider()
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .id(Self.uploadsSectionID)
                }
                .scrollTargetLayout()
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 40)
            }
            .scrollPosition($scrollPosition)
            .onChange(of: showUploads, initial: true) { _, show in
                guard show else { return }
                showUploads = false
                withAnimation {
                    scrollPosition.scrollTo(id: Self.uploadsSectionID, anchor: .top)
                }
            }
        }
        .task {
            await pairingManager.checkServerReachability()
            await loadUserProfile()
        }
        .sheet(isPresented: $showQRScanner) {
            QRScannerView { code in
                showQRScanner = false
                if let parsed = pairingManager.parseQRCode(code) {
                    Task {
                        let didPair = await pairingManager.pair(serverURL: parsed.server, token: parsed.token)
                        if didPair {
                            await loadUserProfile()
                        } else {
                            await MainActor.run { showRejectedCodeAlert = true }
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
        .alert("Disconnect?", isPresented: $showDisconnectAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Disconnect", role: .destructive) {
                pairingManager.disconnect()
            }
        } message: {
            Text("This will remove your server pairing. You'll need to scan a QR code again to reconnect.")
        }
    }

    @ViewBuilder
    private var pairingStatus: some View {
        StatusPill(status: pairingManager.isServerReachable ? .connected : .notConnected)
        if pairingManager.isServerReachable, let url = pairingManager.serverURL {
            Text(url)
                .font(.montserrat(size: 11, weight: .medium))
                .foregroundColor(.white.opacity(0.75))
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    @ViewBuilder
    private var pairingButtons: some View {
        PillButton(
            icon: "qrcode",
            label: "Re-pair",
            tint: AppConstants.journeyGreen,
            action: { showQRScanner = true }
        )
        PillButton(
            icon: "xmark.circle",
            label: "Disconnect",
            tint: AppConstants.redAction,
            action: { showDisconnectAlert = true }
        )
    }

    private func loadUserProfile() async {
        guard pairingManager.isPaired else {
            print("[SettingsScreen] loadUserProfile: not paired, skipping")
            userProfile = nil
            return
        }
        do {
            let profile = try await APIService.shared.fetchMe()
            print("[SettingsScreen] fetchMe OK: \(profile.username) (\(profile.fullName))")
            userProfile = profile
        } catch {
            print("[SettingsScreen] fetchMe FAILED: \(error)")
            
            userProfile = nil
        }
    }
}

struct ProfileHeaderView: View {
    let profile: APIService.Profile

    var body: some View {
        HStack(spacing: 14) {
            avatar
                .frame(width: 72, height: 72)
                .clipShape(Circle())
                .overlay(Circle().stroke(AppConstants.journeyGreen.opacity(0.35), lineWidth: 2))

            VStack(alignment: .leading, spacing: 4) {
                Text(profile.fullName)
                    .font(.montserrat(size: 20, weight: .heavy))
                    .foregroundColor(.white)
                    .lineLimit(2)
                if profile.username != profile.fullName {
                    Text("\(profile.username)")
                        .font(.montserrat(size: 13))
                        .foregroundColor(AppConstants.secondaryText)
                        .lineLimit(1)
                }
            }
            Spacer()
        }
        .padding(18)
        .background(SettingsCardBackground())
    }

    @ViewBuilder
    private var avatar: some View {
        if let url = profile.absoluteAvatarURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty:
                    ZStack {
                        Color.black
                        ProgressView().tint(AppConstants.journeyGreen)
                    }
                case .failure:
                    initialsAvatar
                @unknown default:
                    initialsAvatar
                }
            }
        } else {
            initialsAvatar
        }
    }

    private var initialsAvatar: some View {
        ZStack {
            Color.black
            Text(profile.initials)
                .font(.montserrat(size: 22, weight: .semibold))
                .foregroundColor(AppConstants.journeyGreen)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
    }
}

private struct SettingsSectionHeader: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.montserrat(size: 11, weight: .semibold))
            .tracking(1.2)
            .foregroundColor(.white.opacity(0.5))
            .padding(.leading, 2)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct SettingsCardBackground: View {
    var body: some View {
        RoundedRectangle(cornerRadius: JourneyCardView.cornerRadius, style: .continuous)
            .fill(AppConstants.darkCardBackground)
            .overlay(
                RoundedRectangle(cornerRadius: JourneyCardView.cornerRadius, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
    }
}

struct SettingsSection<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .padding(18)
        .background(SettingsCardBackground())
    }
}

struct SettingsToggle: View {
    let icon: String
    let iconColor: Color
    let label: String
    let detail: String?
    @Binding var isOn: Bool

    init(
        icon: String,
        iconColor: Color,
        label: String,
        detail: String? = nil,
        isOn: Binding<Bool>
    ) {
        self.icon = icon
        self.iconColor = iconColor
        self.label = label
        self.detail = detail
        self._isOn = isOn
    }

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(iconColor.opacity(0.15))
                .frame(width: 32, height: 32)
                .overlay(
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(iconColor)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.montserrat(size: 15, weight: .medium))
                    .foregroundColor(.white)
                if let detail {
                    Text(detail)
                        .font(.montserrat(size: 12))
                        .foregroundColor(AppConstants.secondaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Toggle("", isOn: $isOn)
                .labelsHidden()
                .tint(AppConstants.journeyGreen)
        }
        .padding(.vertical, 10)
    }
}

private struct SettingsDivider: View {
    var body: some View {
        Rectangle()
            .fill(AppConstants.darkCardBorder.opacity(0.4))
            .frame(height: 0.5)
            .padding(.leading, 46)
    }
}

private struct PillButton: View {
    let icon: String
    let label: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 13, weight: .semibold))
                Text(label)
                    .font(.montserrat(size: 14, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundColor(tint)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 12)
            .background(Capsule().fill(Color.white.opacity(0.08)))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
    }
}

struct AppearanceRow: View {
    let icon: String
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .foregroundColor(AppConstants.journeyGreen)
                    .frame(width: 20)
                Text(label)
                    .font(.montserrat(size: 15))
                    .foregroundColor(.white)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundColor(AppConstants.journeyGreen)
                }
            }
        }
    }
}

struct UploadQueueRow: View {
    let item: UploadQueueItem
    let onUpload: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Group {
                switch item.status {
                case .complete:
                    Circle()
                        .fill(AppConstants.journeyGreen.opacity(0.2))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Image(systemName: "checkmark")
                                .font(.system(size: 17, weight: .bold))
                                .foregroundColor(AppConstants.journeyGreen)
                        )
                case .queued:
                    Circle()
                        .fill(Color.orange.opacity(0.2))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Image(systemName: "clock")
                                .font(.system(size: 17, weight: .bold))
                                .foregroundColor(.orange)
                        )
                case .uploading:
                    Circle()
                        .fill(AppConstants.journeyGreen.opacity(0.2))
                        .frame(width: 40, height: 40)
                        .overlay(
                            ProgressView()
                                .tint(.white)
                        )
                case .failed:
                    Circle()
                        .fill(AppConstants.redAction.opacity(0.2))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Image(systemName: "exclamationmark")
                                .font(.system(size: 17, weight: .bold))
                                .foregroundColor(AppConstants.redAction)
                        )
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(item.fileName)
                    .font(.montserrat(size: 14, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)
                Text(item.statusText)
                    .font(.montserrat(size: 13))
                    .foregroundColor(AppConstants.secondaryText)
            }

            Spacer()

            if case .queued = item.status {
                Button(action: onUpload) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundColor(AppConstants.journeyGreen)
                }
            }
        }
        .padding(.vertical, 6)
    }
}
