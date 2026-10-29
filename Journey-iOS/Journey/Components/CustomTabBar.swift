import SwiftUI

struct CustomTabBar: View {
    @Binding var selectedTab: Int

    private struct Item {
        let title: String
        let icon: String
        let tag: Int
    }

    private let items: [Item] = [
        Item(title: "Home", icon: "house.fill", tag: 0),
        Item(title: "Journeys", icon: "doc.text.magnifyingglass", tag: 1),
        Item(title: "Settings", icon: "gearshape.fill", tag: 2)
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.tag) { item in
                Button {
                    selectedTab = item.tag
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: item.icon)
                            .font(.system(size: 22))
                        Text(item.title)
                            .font(.montserrat(size: 10, weight: .medium))
                    }
                    .foregroundColor(selectedTab == item.tag ? AppConstants.journeyGreen : AppConstants.secondaryText)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 4)
        .background(
            Color.black
                .overlay(
                    Rectangle()
                        .fill(AppConstants.darkCardBorder)
                        .frame(height: 0.5),
                    alignment: .top
                )
                .ignoresSafeArea(edges: .bottom)
        )
    }
}
