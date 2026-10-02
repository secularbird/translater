#[cfg(debug_assertions)]
mod diagnostics;
mod model;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_microphone::init())
        .manage(model::Network::default());
    #[cfg(debug_assertions)]
    let builder = builder
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                diagnostics::on_load(webview);
            }
        })
        .invoke_handler(tauri::generate_handler![
            model::transcribe,
            model::translate,
            model::probe,
            model::cancel_request,
            diagnostics::offline_self_test_result
        ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        model::transcribe,
        model::translate,
        model::probe,
        model::cancel_request
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("Unable to start Sonora");
}
