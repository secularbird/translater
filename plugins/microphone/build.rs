fn main() {
    tauri_plugin::Builder::new(&[
        "start", "stop", "status", "insets", "check_permissions", "request_permissions",
        "register_listener", "remove_listener",
    ])
    .android_path("android")
    .ios_path("ios")
    .build();
}
