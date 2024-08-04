import SwiftUI

struct ProcessingSheet: View {
    var body: some View {
        ZStack {
            Color.black.edgesIgnoringSafeArea(.all)
            
            HStack(spacing: 10) {

                ShimmeringText(text: "Processing", baseColor: Color(hex: "#545454"))
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(Color(hex:"#222223"))
            }
            .foregroundColor(.white)
        }
        .interactiveDismissDisabled()
    }
}
