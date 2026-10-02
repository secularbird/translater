// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-microphone",
    platforms: [.iOS(.v14)],
    products: [.library(name: "tauri-plugin-microphone", type: .static, targets: ["tauri-plugin-microphone"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-microphone", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
