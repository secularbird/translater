"""Summarize the latest available suite artifacts without rerunning tests."""
import html
import json
import re
import time
import xml.etree.ElementTree as ET
from reporting import OUTPUT


def main():
    suites = []
    for name in ["unit", "browser", "android"]:
        path = OUTPUT / f"{name}.xml"
        if not path.exists():
            continue
        cases = list(ET.parse(path).getroot().iter("testcase"))
        failures = sum(c.find("failure") is not None or c.find("error") is not None for c in cases)
        skipped = sum(c.find("skipped") is not None for c in cases)
        suites.append({"name": name, "tests": len(cases), "failures": failures, "skipped": skipped,
                       "artifact": path.name, "updated": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(path.stat().st_mtime))})
    rust = OUTPUT / "rust.log"
    if rust.exists():
        text = rust.read_text(encoding="utf-8")
        results = re.findall(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", text)
        suites.append({"name": "rust", "tests": sum(int(p) + int(f) + int(s) for _, p, f, s in results),
                       "failures": sum(int(f) for _, _, f, _ in results) if results and "error:" not in text else 1,
                       "skipped": sum(int(s) for _, _, _, s in results), "artifact": rust.name,
                       "updated": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(rust.stat().st_mtime))})
    total = sum(s["tests"] for s in suites)
    failed = sum(s["failures"] for s in suites)
    skipped = sum(s["skipped"] for s in suites)
    real_models = []
    for name in ['offline-real', 'offline-android', 'offline-desktop']:
        path = OUTPUT / f'{name}.json'
        if path.exists():
            data = json.loads(path.read_text())
            real_models.append({'suite': name, 'passed': data.get('passed', False), 'artifact': path.name,
                                'samples': len(data.get('results', data.get('records', [])))})
    residency = []
    for name in ['residency-desktop', 'residency-android']:
        path = OUTPUT / f'{name}.json'
        if path.exists():
            data = json.loads(path.read_text())
            residency.append({'suite': name, 'passed': data.get('passed', False), 'artifact': path.name,
                              'load_counts': data.get('loadCounts', {}), 'last_round': data.get('rounds', [{}])[-1]})
    report = {"tests": total, "passed": total - failed - skipped, "failures": failed, "skipped": skipped, "suites": suites, 'real_models': real_models, 'residency': residency}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "latest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    rows = "".join(f"<tr><td>{s['name']}</td><td>{s['tests']}</td><td>{s['failures']}</td><td>{s['skipped']}</td><td>{s['updated']}</td><td><a href='{s['artifact']}'>详情</a></td></tr>" for s in suites)
    pictures = "".join(f"<a href='{html.escape(p.name)}'><img alt='{html.escape(p.stem)}' src='{html.escape(p.name)}'></a>" for p in sorted(OUTPUT.glob("responsive-*.png")))
    real_rows = ''.join(f"<tr><td>{r['suite']}</td><td>{'PASS' if r['passed'] else 'FAIL'}</td><td>{r['samples']} 个真实样例</td><td><a href='{r['artifact']}'>原始结果</a></td></tr>" for r in real_models)
    resident_rows = ''.join(f"<tr><td>{r['suite']}</td><td>{'PASS' if r['passed'] else 'FAIL'}</td><td>加载次数 {html.escape(str(r['load_counts']))}</td><td><a href='{r['artifact']}'>计时与结果</a></td></tr>" for r in residency)
    document = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sonora 测试结果</title>
<style>body{{font:15px sans-serif;max-width:1100px;margin:40px auto;padding:20px;color:#2c3b2e}}table{{border-collapse:collapse;width:100%}}td,th{{padding:12px;text-align:left;border-bottom:1px solid #ddd}}a{{color:#3a7050}}img{{max-width:220px;max-height:400px;object-fit:contain;margin:12px;border:1px solid #eee}}.table{{overflow:auto}}</style>
<h1>Sonora 自动化测试</h1><h2>{total - failed - skipped} 通过 / {failed} 失败 / {skipped} 跳过</h2>
<p>汇总各套件最近一次的报告；时间分别列出，未生成报告的套件不计入结果。</p><div class="table"><table><tr><th>套件</th><th>用例</th><th>失败</th><th>跳过</th><th>报告时间</th><th>产物</th></tr>{rows}</table></div>
<h2>真实 WASM 推理</h2><table>{real_rows}</table><p>真实模型样例不计入上方常规测试用例数。offline-real 阻断外部网络；Android / macOS 使用原生 WebView 和实际权重。</p>
<h2>常驻与连续推理</h2><table>{resident_rows}</table><p>三轮交替使用同一对 Worker；实际界面重复开始/停止的模型加载次数也单独验证。</p>
<h2>界面快照</h2>{pictures}<p>常规浏览器用例使用本地 HTTP/SSE 测试服务；真实模型检查单列。尚未完成实体手机、iOS、Windows、Linux 实机验收或系统性的准确率评测。</p></html>"""
    (OUTPUT / "latest.html").write_text(document, encoding="utf-8")
    print(f"{report['passed']} passed, {failed} failed, {skipped} skipped — {OUTPUT / 'latest.html'}")
    raise SystemExit(1 if failed or not suites or any(not r['passed'] for r in real_models + residency) else 0)


if __name__ == "__main__":
    main()
