//
//  JourneyApp.swift
//  Journey Watch App
//
//  Created by Mason Doan on 12/3/23.
//

import SwiftUI

@main
struct Journey_Watch_AppApp: App {
    var userSettings = UserSettings()
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(userSettings)
        }
    }
}
