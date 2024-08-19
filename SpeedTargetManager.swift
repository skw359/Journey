import SwiftUI
import WatchKit

class SpeedTargetManager: ObservableObject {
    @Published var targetSpeed: Int = 60
    @Published var isSettingSpeed = false
    @Published var hitTargetSpeed = false
    @Published var waitingForGPS = false
    @Published var setSpeed = false
    @Published var targetReachedTime: Date?
    
    @Published var elapsedTime: TimeInterval = 0
    var startTime: Date?
    private var timer: Timer?
    
    func setTargetSpeed(locationManager: LocationManager, completion: @escaping () -> Void) {
        waitingForGPS = true
        isSettingSpeed = true
        hitTargetSpeed = false
        
        elapsedTime = 0
        startTime = nil
        stopTiming()
        
        // Check for strong GPS signal
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            if let location = locationManager.latestLocation, location.horizontalAccuracy <= 500 {
                timer.invalidate()
                self?.waitingForGPS = false
                self?.isSettingSpeed = false
                self?.setSpeed = true
                completion()
            }
        }
    }
    
    func updateStatus(currentSpeed: Double) {
        if hitTargetSpeed {
            return  // Exit early if target speed has already been hit
        }
        
        if currentSpeed >= Double(targetSpeed) {
            hitTargetSpeed = true
            targetReachedTime = Date()
            stopTiming()
            WKInterfaceDevice.current().play(.success)
        }
    }
    
    func startTiming() {
        if startTime == nil && setSpeed {
            startTime = Date()
            timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in
                guard let self = self, let startTime = self.startTime else { return }
                self.elapsedTime = Date().timeIntervalSince(startTime)
            }
        }
    }
    
    func stopTiming() {
        timer?.invalidate()
        timer = nil
    }
    
    func reset() {
        hitTargetSpeed = false
        elapsedTime = 0
        setSpeed = false
        startTime = nil
        stopTiming()
    }
    
    func formatTime(_ timeInterval: TimeInterval) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.minute, .second]
        formatter.unitsStyle = .positional
        formatter.zeroFormattingBehavior = .pad
        
        let hours = Int(timeInterval) / 3600
        let remainingTime = timeInterval.truncatingRemainder(dividingBy: 3600)
        let baseString = formatter.string(from: remainingTime) ?? "00:00"
        let milliseconds = Int((timeInterval.truncatingRemainder(dividingBy: 1)) * 100)
        
        if hours > 0 {
            return String(format: "%02d:%@.%02d", hours, baseString, milliseconds)
        } else {
            return String(format: "%@.%02d", baseString, milliseconds)
        }
    }
}
