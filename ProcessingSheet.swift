import SwiftUI

struct ProcessingSheet: View {
    var body: some View {
        ZStack {
            Color.black.edgesIgnoringSafeArea(.all)
            
            HStack(spacing: 10) {
                Image(systemName: "cpu.fill")
                    .foregroundColor(.white)
                
                Text("Processing")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(.white)
            }
        }
        .interactiveDismissDisabled()
    }
}
