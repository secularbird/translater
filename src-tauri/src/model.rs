use base64::{engine::general_purpose::STANDARD, Engine};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{multipart, Client, Response, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

type Requests = Arc<Mutex<HashMap<String, CancellationToken>>>;
pub struct Network {
    client: Client,
    requests: Requests,
}
impl Default for Network {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(90))
                // Never forward credentials or audio to a redirected host.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Unable to create HTTP client"),
            requests: Arc::default(),
        }
    }
}
struct ActiveRequest {
    id: String,
    requests: Requests,
    token: CancellationToken,
}
impl ActiveRequest {
    fn new(network: &Network, id: String) -> Result<Self, String> {
        let token = CancellationToken::new();
        let mut requests = network.requests.lock().map_err(|_| "请求状态不可用")?;
        if requests.contains_key(&id) {
            return Err("请求 ID 重复".into());
        }
        requests.insert(id.clone(), token.clone());
        Ok(Self {
            id,
            requests: network.requests.clone(),
            token,
        })
    }
}
impl Drop for ActiveRequest {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(&self.id);
        }
    }
}

fn validate_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "无效的模型服务地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("仅支持不含账号密码的 HTTP(S) 服务地址".into());
    }
    Ok(url)
}
fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "请求超时，请检查模型服务或使用更小的模型。".into()
    } else if error.is_connect() {
        "无法连接模型服务，请检查地址和端口，确认服务已启动。".into()
    } else {
        format!("模型请求失败：{}", error.without_url())
    }
}
async fn check_response(response: Response) -> Result<Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or_default();
    let detail = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .unwrap_or("请检查服务地址、模型名称和 API Key。");
    Err(format!(
        "服务返回 {status}：{}",
        detail.chars().take(250).collect::<String>()
    ))
}

#[derive(Serialize)]
pub struct Recognition {
    text: String,
    language: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transcribe(
    network: State<'_, Network>,
    request_id: String,
    url: String,
    api_key: String,
    model: String,
    language: String,
    protocol: String,
    audio: String,
) -> Result<Recognition, String> {
    let request = ActiveRequest::new(&network, request_id)?;
    let task = async {
        let url = validate_url(&url)?;
        if audio.len() > 4_000_000 {
            return Err("语音片段过大，请缩短分段时间".into());
        }
        let bytes = STANDARD.decode(&audio).map_err(|_| "无效的音频编码")?;
        if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err("音频必须是有效的 WAV 文件".into());
        }
        let format = if model.starts_with("gpt-4o") {
            "json"
        } else {
            "verbose_json"
        };
        let mut form = multipart::Form::new()
            .part(
                "file",
                multipart::Part::bytes(bytes)
                    .file_name("speech.wav")
                    .mime_str("audio/wav")
                    .map_err(|e| e.to_string())?,
            )
            .text("model", model)
            .text("response_format", format);
        if language != "auto" || protocol == "whisper" {
            form = form.text("language", language.clone());
        }
        let mut builder = network.client.post(url).multipart(form);
        if !api_key.is_empty() {
            builder = builder.bearer_auth(api_key);
        }
        let response = check_response(builder.send().await.map_err(network_error)?).await?;
        let result: Value = response.json().await.map_err(network_error)?;
        let text = result
            .get("text")
            .and_then(Value::as_str)
            .ok_or("语音服务响应缺少 text 字段，请检查接口协议。")?
            .trim()
            .to_owned();
        let detected = result
            .get("language")
            .and_then(Value::as_str)
            .or_else(|| result.pointer("/result/language").and_then(Value::as_str))
            .unwrap_or(if language == "auto" {
                "unknown"
            } else {
                &language
            })
            .to_owned();
        Ok(Recognition {
            text,
            language: detected,
        })
    };
    tokio::select! {
        result = task => result,
        _ = request.token.cancelled() => Err("请求已取消".into()),
    }
}

#[tauri::command]
pub async fn translate(
    network: State<'_, Network>,
    request_id: String,
    url: String,
    api_key: String,
    body: Value,
    channel: Channel<String>,
) -> Result<(), String> {
    let request = ActiveRequest::new(&network, request_id)?;
    let task = async {
        let mut builder = network.client.post(validate_url(&url)?).json(&body);
        if !api_key.is_empty() {
            builder = builder.bearer_auth(api_key);
        }
        let response = check_response(builder.send().await.map_err(network_error)?).await?;
        let streaming = response
            .headers()
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| s.contains("text/event-stream"));
        if !streaming {
            let result: Value = response.json().await.map_err(network_error)?;
            let content = result
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or("翻译服务未返回有效译文")?;
            channel
                .send(content.to_owned())
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        let mut events = response.bytes_stream().eventsource();
        let (mut received, mut complete) = (false, false);
        while let Some(event) = events.next().await {
            let data = event.map_err(|e| format!("翻译连接中断：{e}"))?.data;
            if data == "[DONE]" {
                complete = true;
                break;
            }
            let value: Value =
                serde_json::from_str(&data).map_err(|_| "翻译服务返回了无效的 SSE 数据")?;
            if let Some(error) = value.get("error") {
                return Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("翻译服务发生错误")
                    .to_owned());
            }
            if let Some(token) = value
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                received = true;
                channel.send(token.to_owned()).map_err(|e| e.to_string())?;
            }
            if let Some(reason) = value
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
            {
                if reason != "stop" {
                    return Err(format!("译文未完整返回（{reason}），已保留部分内容。"));
                }
                complete = true;
            }
        }
        if !received {
            return Err("模型没有生成译文，请检查模型配置。".into());
        }
        if !complete {
            return Err("翻译连接中断，已保留部分译文，可重试。".into());
        }
        Ok(())
    };
    tokio::select! {
        result = task => result,
        _ = request.token.cancelled() => Err("请求已取消".into()),
    }
}

#[tauri::command]
pub async fn probe(
    network: State<'_, Network>,
    url: String,
    api_key: String,
) -> Result<Value, String> {
    let mut builder = network
        .client
        .get(validate_url(&url)?)
        .timeout(Duration::from_secs(10));
    if !api_key.is_empty() {
        builder = builder.bearer_auth(api_key);
    }
    check_response(builder.send().await.map_err(network_error)?).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn cancel_request(network: State<'_, Network>, request_id: String) -> Result<(), String> {
    if let Some(token) = network
        .requests
        .lock()
        .map_err(|_| "请求状态不可用")?
        .get(&request_id)
    {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_support_lan_but_reject_non_http_and_credentials() {
        assert!(validate_url("http://192.168.1.12:8080/inference").is_ok());
        assert!(validate_url("https://api.example.com/v1/chat/completions").is_ok());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("https://key:secret@example.com").is_err());
    }
    #[test]
    fn requests_are_removed_on_success_error_and_cancellation() {
        let network = Network::default();
        let request = ActiveRequest::new(&network, "one".into()).unwrap();
        assert!(ActiveRequest::new(&network, "one".into()).is_err());
        request.token.cancel();
        assert!(request.token.is_cancelled());
        drop(request);
        assert!(network.requests.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn event_stream_preserves_split_unicode() {
        let data = "data: {\"text\":\"你好\"}\r\n\r\ndata: [DONE]\n\n".as_bytes();
        let parts: Vec<Result<Vec<u8>, std::io::Error>> =
            data.chunks(1).map(|c| Ok(c.to_vec())).collect();
        let result: Vec<_> = futures_util::stream::iter(parts)
            .eventsource()
            .collect()
            .await;
        assert_eq!(result[0].as_ref().unwrap().data, "{\"text\":\"你好\"}");
        assert_eq!(result[1].as_ref().unwrap().data, "[DONE]");
    }
}
