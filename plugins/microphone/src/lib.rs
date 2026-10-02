use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_microphone);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("microphone")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("com.sonora.microphone", "MicrophonePlugin")?;
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_microphone)?;
            Ok(())
        })
        .build()
}
