"""Local HTTP fixtures with genuine delayed SSE responses. No real inference."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading


class ModelFixture:
    def __init__(self):
        self.reset()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def response_headers(self, status, content_type, length=None):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Connection", "close")
                if length is not None:
                    self.send_header("Content-Length", str(length))
                self.end_headers()
                self.close_connection = True

            def json_response(self, data, status=200):
                body = json.dumps(data, ensure_ascii=False).encode()
                self.response_headers(status, "application/json", len(body))
                self.wfile.write(body)

            def do_OPTIONS(self):
                self.response_headers(204, "text/plain", 0)

            def do_GET(self):
                self.json_response({"data": [{"id": "fixture-model"}]})

            def do_POST(self):
                payload = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                request = {"path": self.path, "body": payload,
                           "authorization": self.headers.get("Authorization")}
                fixture.requests.append(request)
                mode, gate = fixture.mode, fixture.gate
                if self.path.endswith(("/inference", "/audio/transcriptions")):
                    if mode == "asr-failure":
                        self.json_response({"error": {"message": "Fixture ASR unavailable"}}, 503)
                    else:
                        self.json_response({"text": "" if mode == "silence" else fixture.asr_text,
                                            "language": "english"})
                    return
                if not self.path.endswith("/chat/completions"):
                    self.json_response({"error": {"message": "Unexpected fixture endpoint"}}, 404)
                    return
                request["json"] = json.loads(payload)
                if mode == "unauthorized":
                    self.json_response({"error": {"message": "Fixture API key rejected"}}, 401)
                    return
                self.response_headers(200, "text/event-stream; charset=utf-8")
                try:
                    for index, token in enumerate(["很高兴", "终于能与你", "面对面交流。"]):
                        data = json.dumps({"choices": [{"delta": {"content": token}}]}, ensure_ascii=False)
                        self.wfile.write(f"data: {data}\r\n\r\n".encode())
                        self.wfile.flush()
                        if index == 0:
                            if mode == "truncated":
                                return
                            if mode == "delayed" and not gate.wait(timeout=20):
                                return
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Expected when the client cancels or closes its context.

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def reset(self, mode="normal"):
        if hasattr(self, "gate"):
            self.gate.set()
        self.requests = []
        self.mode = mode
        self.asr_text = "It's lovely to finally meet you in person."
        self.gate = threading.Event()

    def settings(self):
        profile = {
            "asrProtocol": "whisper",
            "asr": {"url": self.base_url + "/asr", "model": "fixture-asr", "apiKey": ""},
            "translation": {"url": self.base_url + "/translation/v1", "model": "fixture-translation", "apiKey": ""},
        }
        return {"provider": "local", "local": profile, "remote": {**profile, "asrProtocol": "openai"},
                "sourceLanguage": "auto", "targetLanguage": "zh", "deviceId": "", "vadSilenceSeconds": 0.8, "autoScroll": True}

    def close(self):
        self.gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
