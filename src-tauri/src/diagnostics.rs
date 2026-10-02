//! Debug-build-only harness for exercising the actual desktop WKWebView.
use serde_json::Value;
use tauri::Manager;

pub fn on_load(webview: &tauri::Webview) {
    let Ok(config) = std::env::var("SONORA_WASM_SELFTEST") else {
        return;
    };
    let Ok(config) = serde_json::from_str::<Value>(&config) else {
        return;
    };
    eprintln!("SONORA_WASM_STAGE=page-loaded");
    #[cfg(target_os = "macos")]
    let _ = webview.app_handle().show();
    if let Some(window) = webview.app_handle().get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let script = include_str!("../../tests/desktop_wasm.js")
        .replace("__SONORA_TEST_CONFIG__", &config.to_string())
        .replace("__SONORA_VAD_CHECK__", include_str!("../../tests/native_vad.js"))
        .replace(
            "__SONORA_RESIDENCY_BENCHMARK__",
            include_str!("../../tests/residency_benchmark.js"),
        );
    if let Err(error) = webview.eval(&script) {
        eprintln!("Unable to run desktop WASM diagnostic: {error}");
    }
}

#[tauri::command]
pub fn offline_self_test_result(app: tauri::AppHandle, result: Value) -> Result<(), String> {
    if std::env::var_os("SONORA_WASM_SELFTEST").is_none() {
        return Err("Desktop test harness is not enabled".into());
    }
    if result.get("stage").is_some() {
        println!("SONORA_WASM_STAGE={result}");
        return Ok(());
    }
    println!("SONORA_WASM_RESULT={result}");
    app.exit(
        if result.get("passed").and_then(Value::as_bool) == Some(true) {
            0
        } else {
            1
        },
    );
    Ok(())
}
