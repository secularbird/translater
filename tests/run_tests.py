"""Portable test runner: owns its Vite server and writes a combined report."""
import argparse
import html
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from reporting import ROOT, OUTPUT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", choices=["all", "browser", "android", "offline", "vad"], default="all")
    parser.add_argument("--android", metavar="SERIAL", help="Include Android UI tests; app must be installed")
    parser.add_argument("--adb")
    parser.add_argument("--permissions", action="store_true", help="Include first-grant and denial Android tests")
    args = parser.parse_args()
    if args.suite == "android" and not args.android:
        parser.error("--suite android requires --android SERIAL")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    steps = []

    def run(name, command, timeout=180, env=None):
        started = time.monotonic()
        print(f"\nRunning {name}: {' '.join(command)}", flush=True)
        log = OUTPUT / f"{name}.log"
        detail = ""
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, timeout=timeout)
            log.write_text(result.stdout + result.stderr, encoding="utf-8")
            print(result.stdout + result.stderr, flush=True)
            code = result.returncode
        except (subprocess.TimeoutExpired, OSError) as error:
            detail = str(error)
            code = 1
            log.write_text(detail, encoding="utf-8")
            print(detail, flush=True)
        steps.append({"name": name, "passed": code == 0, "seconds": round(time.monotonic() - started, 2),
                      "command": command, "log": log.name, "detail": detail})
        return code == 0

    if args.suite == "all":
        run("unit", ["npm", "test", "--", "--reporter=default", "--reporter=junit", f"--outputFile.junit={OUTPUT / 'unit.xml'}"])
        run("rust", ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml"], timeout=300)
        run("build", ["npm", "run", "build"])

    if args.suite in ("all", "browser", "offline", "vad"):
        subprocess.run([sys.executable, 'scripts/prepare_test_audio.py'], cwd=ROOT, check=True)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base_url = f"http://127.0.0.1:{port}"
        with (OUTPUT / "vite.log").open("w", encoding="utf-8") as log:
            server = subprocess.Popen(["npm", "run", "dev", "--", "--port", str(port)], cwd=ROOT,
                                      stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                deadline = time.monotonic() + 30
                while True:
                    if server.poll() is not None:
                        raise RuntimeError("Vite exited early; see vite.log")
                    try:
                        with urllib.request.urlopen(base_url, timeout=1) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        pass
                    if time.monotonic() > deadline:
                        raise RuntimeError("Timed out waiting for Vite")
                    time.sleep(0.2)
                suite_name = "vad-real" if args.suite == "vad" else "offline-real" if args.suite == "offline" else "browser"
                suite_file = "tests/vad_real.py" if args.suite == "vad" else "tests/offline_real.py" if args.suite == "offline" else "tests/e2e.py"
                run(suite_name, [sys.executable, suite_file], timeout=600 if args.suite == "offline" else 240,
                    env={**os.environ, "SONORA_BASE_URL": base_url, "SONORA_TEST_OUTPUT": str(OUTPUT)})
            except Exception as error:
                steps.append({"name": "browser", "passed": False, "seconds": 0, "command": [], "log": "vite.log", "detail": str(error)})
            finally:
                if server.poll() is None:
                    os.killpg(server.pid, signal.SIGTERM)
                    try:
                        server.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        os.killpg(server.pid, signal.SIGKILL)
                        server.wait()

    if args.android:
        command = [sys.executable, "tests/android_smoke.py", "--serial", args.android]
        if args.adb:
            command += ["--adb", args.adb]
        if args.permissions:
            command += ["--permissions"]
        run("android", command, timeout=240, env={**os.environ, "SONORA_TEST_OUTPUT": str(OUTPUT)})

    passed = all(step["passed"] for step in steps)
    summary = {"passed": passed, "generated": time.strftime("%Y-%m-%d %H:%M:%S %z"), "steps": steps,
               "model_inference": "Real SenseVoice/M2M100 WASM samples; external network blocked" if args.suite == "offline" else "HTTP/SSE fixture tests; real-model suites are reported separately"}
    (OUTPUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    rows = "".join(f"<tr><td>{html.escape(step['name'])}</td><td>{'PASS' if step['passed'] else 'FAIL'}</td><td>{step['seconds']}s</td><td><a href='{step['log']}'>log</a></td></tr>" for step in steps)
    (OUTPUT / "index.html").write_text(f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Sonora test report</title>
<style>body{{font:16px sans-serif;max-width:900px;margin:48px auto;padding:20px;color:#26352a}}table{{border-collapse:collapse;width:100%}}td,th{{padding:14px;text-align:left;border-bottom:1px solid #ddd}}a{{color:#376547}}</style>
<h1>Sonora 自动化测试：{'通过' if passed else '失败'}</h1><p>{summary['generated']}</p><table><tr><th>Suite</th><th>Status</th><th>Time</th><th>Details</th></tr>{rows}</table>
<p>{html.escape(summary['model_inference'])}。真实模型结果也可在 latest.html 中查看。</p>
<p>逐用例报告：<a href="browser.xml">browser.xml</a> / <a href="android.xml">android.xml</a> / <a href="unit.xml">unit.xml</a>。截图、trace.zip 与日志位于同一目录。</p></html>""", encoding="utf-8")
    print(f"\n{'PASS' if passed else 'FAIL'} — report: {OUTPUT / 'index.html'}", flush=True)
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
