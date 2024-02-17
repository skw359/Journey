Text(userSettings.isMetric ?
    (userSettings.usePreciseUnits || locationManager.distance * 1.60934 < 16.09 ? "\(formatDisplayValue(locationManager.distance * 1.60934, usePreciseUnits: userSettings.usePreciseUnits)) " :
       "\(Int(locationManager.distance * 1.60934)) ") :
    (userSettings.usePreciseUnits || locationManager.distance < 10 ? "\(formatDisplayValue(locationManager.distance, usePreciseUnits: userSettings.usePreciseUnits)) " :
       "\(Int(locationManager.distance)) "))
.font(.system(size: 45))
.fontWeight(.bold)
.foregroundColor(userSettings.isDarkMode ? .black : .white) +
Text(userSettings.isMetric ? "KM" : "MILES")
    .font(.headline)
    .fontWeight(.bold)
    .foregroundColor(Color(UIColor(hex: "#05df73")))
