import SwiftUI

struct StartScreen: View {
    @Binding var showSettings: Bool
    @Binding var obtainedGPS: Bool
    @ObservedObject var locationManager: LocationManager
    var startRecording: () -> Void
    @State private var showIndoorExplanation = false
    
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                VStack {
                    Button(action: startRecording) {
                        HStack(alignment: .center, spacing: 10) {
                            Image("recordsymbol")
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: geometry.size.width > 176 ? 30 : 20,
                                       height: geometry.size.width > 176 ? 30 : 20)
                                .foregroundColor(obtainedGPS ? Color(hex: "#00ff81") : Color.gray)
                            if geometry.size.width > 176 {
                                Text(obtainedGPS ? "Record Journey" : "Searching GPS")
                                    .fontWeight(.bold)
                                    .foregroundColor(obtainedGPS ? .white : Color.gray)
                            } else {
                                Text(obtainedGPS ? "Record" : "Searching")
                                    .fontWeight(.bold)
                                    .foregroundColor(obtainedGPS ? .white : Color.gray)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(obtainedGPS ? Color(hex: "#0c3617") : Color(hex: "#222223"))
                        .cornerRadius(15)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .disabled(!obtainedGPS)
                    .overlay(
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
                                Image(systemName: "info.circle")
                                    .font(.system(size: 14, weight: .bold))
                                    .foregroundColor(Color(hex: "#2cdbae"))
                                Text("Don't use indoors.")
                                    .font(.system(size: 12))
                                    .foregroundColor(Color.white)
                                    .padding()
                                Spacer()
                            }
                            .background(geometry.size.width > 176 ? Color(hex: "#000000") : Color.clear)
                            .cornerRadius(100)
                            .frame(width: 180)
                            .offset(y: 80)
                            .onTapGesture {
                                showIndoorExplanation = true
                            }
                            Spacer()
                        }
                    )
                }
                Button(action: {
                    showSettings = true
                }) {
                    Image(systemName: "gear")
                        .font(.title)
                        .foregroundColor(.white)
                }
                .buttonStyle(PlainButtonStyle())
                .offset(x: 10, y: -90)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .sheet(isPresented: $showIndoorExplanation) {
            IndoorExplanation()
        }
    }
}

struct IndoorExplanation: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Why can't Journey be used indoors?")
                    .font(.headline)
                    .padding(.bottom)
                    .bold()
                
                Text("Journey relies on satellite signals to accurately track your location and movements. When indoors, these signals can be significantly weakened or blocked by buildings and other structures, leading to inaccurate or no location data.")
                
                Text("For the best experience and most accurate tracking:")
                    .padding(.top)
                
                Text("• Use the app outdoors.")
                Text("• Avoid areas with tall buildings or dense tree cover")
                Text("• Allow a few moments for GPS signal acquisition")
                
                Text("Using the app indoors may result in incomplete or inaccurate data.")
                    .padding(.top)
            }
            .padding()
        }
    }
}
