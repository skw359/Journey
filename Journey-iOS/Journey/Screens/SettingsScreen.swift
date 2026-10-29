import SwiftUI

struct SettingsScreen: View {
    @Environment(PairingManager.self) private var pairingManager
    @Environment(UploadManager.self) private var uploadManager

    @AppStorage(AppConstants.confirmBeforeStoppingKey) private var confirmBeforeStopping = true
    @AppStorage(AppConstants.autoSegmentKey) private var autoSegmentJourneys = false
    @AppStorage(AppConstants.appearanceKey) private var appearance = "dark"
    @AppStorage(AppConstants.useMetricUnitsKey) private var useMetricUnits = false

    @State private var showQRScanner = false
    @State private var showDisconnectAlert = false
    @State private var userProfile: APIService.Profile?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 24) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Settings")
                            .font(.montserrat(size: 32, weight: .bold))
                            .foregroundColor(.white)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8)

                    if let profile = userProfile {
                        ProfileHeaderView(profile: profile)
                    }

                    // Recording
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Recording")
                            .font(.montserrat(size: 13, weight: .semibold))
                            .foregroundColor(AppConstants.secondaryText)
                            .padding(.leading, 4)

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
                        Text("Units")
                            .font(.montserrat(size: 13, weight: .semibold))
                            .foregroundColor(AppConstants.secondaryText)
                            .padding(.leading, 4)

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

                    // Server Pairing
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Server Pairing")
                            .font(.montserrat(size: 13, weight: .semibold))
                            .foregroundColor(AppConstants.secondaryText)
                            .padding(.leading, 4)

                        SettingsSection {
                            VStack(alignment: .leading, spacing: 16) {
                                HStack(spacing: 12) {
                                    Circle()
                                        .fill(pairingManager.isServerReachable ? AppConstants.journeyGreen : .yellow)
                                        .frame(width: 10, height: 10)
                                        .overlay(Circle().stroke(.white.opacity(0.15), lineWidth: 0.5))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(pairingManager.isServerReachable ? "Connected" : "Not Connected")
                                            .font(.montserrat(size: 16, weight: .semibold))
                                            .foregroundColor(.white)
                                        if pairingManager.isServerReachable, let url = pairingManager.serverURL {
                                            Text(url)
                                                .font(.montserrat(size: 12))
                                                .foregroundColor(AppConstants.secondaryText)
                                                .lineLimit(1)
                                                .truncationMode(.middle)
                                        }
                                    }
                                    Spacer()
                                }

                                HStack(spacing: 10) {
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
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    // Upload Queue
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Uploads")
                                .font(.montserrat(size: 13, weight: .semibold))
                                .foregroundColor(AppConstants.secondaryText)
                                .padding(.leading, 4)
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
                                    .foregroundColor(AppConstants.secondaryText)
                                    .frame(width: 28, height: 28)
                                    .background(
                                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                                            .fill(AppConstants.darkCardBackground)
                                    )
                            }
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
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 40)
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
                        await pairingManager.pair(serverURL: parsed.server, token: parsed.token)
                    }
                }
            }
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
                    .font(.montserrat(size: 20, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
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
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [AppConstants.darkCardBackground, AppConstants.darkCardBackground.opacity(0.75)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(AppConstants.darkCardBorder.opacity(0.5), lineWidth: 0.5)
                )
                .shadow(color: .black.opacity(0.35), radius: 14, x: 0, y: 6)
        )
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
        }
    }
}

// MARK: - Settings Components

struct SettingsSection<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [AppConstants.darkCardBackground, AppConstants.darkCardBackground.opacity(0.75)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(AppConstants.darkCardBorder.opacity(0.5), lineWidth: 0.5)
                )
                .shadow(color: .black.opacity(0.35), radius: 14, x: 0, y: 6)
        )
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
        HStack(alignment: .top, spacing: 14) {
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
                        .font(.montserrat(size: 13))
                        .foregroundColor(AppConstants.secondaryText)
                }
            }
            Spacer()
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
                Text(label).font(.montserrat(size: 14, weight: .semibold))
            }
            .foregroundColor(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                Capsule().fill(tint.opacity(0.15))
            )
            .overlay(
                Capsule().stroke(tint.opacity(0.3), lineWidth: 0.5)
            )
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
            // Status icon in circle
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
