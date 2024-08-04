import SwiftUI

struct SpeedGoalInfoSheet: View {
    var onSetSpeed: () -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What's this?")
                .font(.headline)
                .bold()
            
            Text("Speedgoal allows you set a target speed and times your acceleration until you reach it.")
            Text("For example, if you want to measure how long it takes to go from 0 to 60 mph, you would set 60 mph as the target. Once movement is detected, the timer starts automatically and continues until you reach 60 mph. This is useful for quantifying acceleration times, athletes tracking sprint starts, or other fitness metrics.")
            
            Spacer()
            
            Button(action: onSetSpeed) {
                HStack(alignment: .center, spacing: 10) {
                    Image(systemName: "speedometer")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 20, height: 20)
                        .foregroundColor(Color(hex: "#00ff81"))
                    
                    Text("Set Speed")
                        .foregroundColor(.white)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color(hex: "#0c3617"))
                .cornerRadius(15)
            }
            .buttonStyle(PlainButtonStyle())
        }
        .padding()
    }
}

struct SetTargetSpeedSheet: View {
    @Binding var targetSpeed: Int
    @Binding var waitingForGPS: Bool
    var onSetSpeed: () -> Void
    
    var body: some View {
        VStack {
            HStack {
                Image(systemName: "speedometer")
                    .font(.title3)
                    .foregroundColor(Color(hex: "#00ff81"))
                Text("Speedgoal")
                    .font(.title3)
                    .bold()
            }
            .padding()
            
            Text("Tap and scroll to set your target speed.")
                .foregroundColor(.gray)
                .padding(.bottom)
            
            Picker(selection: $targetSpeed, label:
                Text("Target Speed")
                    .fontWeight(.bold)
            ) {
                ForEach(3...1150, id: \.self) { speed in
                    Text("\(speed) mph")
                }
            }
        
            .pickerStyle(WheelPickerStyle())
            .frame(height: 55)
            .padding(.bottom)
            
            GeometryReader { geometry in
                Spacer()
                    .frame(height: geometry.size.height * 0.1)
            }
            
            Button(action: onSetSpeed) {
                HStack {
                    Image(systemName: "checkmark.circle")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 20, height: 20)
                        .foregroundColor(.white)
                    
                    if waitingForGPS {
                        ShimmeringText(text: "Setting Speed...", baseColor: .white)
                    } else {
                        Text("Set Speed")
                            .foregroundColor(.white)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(waitingForGPS ? Color(hex: "#222223") : Color(hex: "#222223"))
                .cornerRadius(15)
            }
            .buttonStyle(PlainButtonStyle())
            .padding(.horizontal)
            .disabled(waitingForGPS)
        }
        .padding(.bottom, 20)
    }
}
