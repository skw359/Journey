import SwiftUI

struct WelcomeScreen: View {
    @Binding var showWelcomeScreen: Bool
    
    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Text("Welcome to Journey.")
                    .font(.title3)
                    .fontWeight(.bold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity, alignment: .center)
                
                Text("Say hello to the simple, ultimate travel companion for adventurers and explorers. Here's what we got:")
                    .font(.headline)
                    .multilineTextAlignment(.leading)
                
                VStack(alignment: .leading, spacing: 15) {
                    featureText("Real-time tracking of distance, speed, elevation, and more.")
                    featureText("Built-in compass, waypoint guidance, and intelligent high altitude alerts to keep you safe.")
                    featureText("Location awareness with current city, state, and county info (internet required)")
                    featureText("Set target speeds and get alerts when you hit your marks.")
                    featureText("Runs independently from iPhone.")
                }
                .padding()
                .background(Color.white.opacity(0.1))
                .cornerRadius(10)
                
                Text("TDLR; Journey is versatile, perfect all types of outdoor enthusiasts, tailored to you.")
                    .font(.caption)
                    .multilineTextAlignment(.leading)
                    .padding()
                
                Button(action: {
                    showWelcomeScreen = false
                    UserDefaults.standard.set(true, forKey: "showWelcomeScreen")
                }) {
                    Text("Start")
                        .fontWeight(.bold)
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.white)
                        .cornerRadius(10)
                }
                .buttonStyle(PlainButtonStyle())
                .padding()
            }
            .padding()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(hex: "#1e4c40").edgesIgnoringSafeArea(.all))
        .foregroundColor(.white)
    }
    
    private func featureText(_ text: String) -> some View {
        HStack(alignment: .top) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(Color(hex: "#05df73"))
            Text(text)
                .font(.subheadline)
        }
    }
}
