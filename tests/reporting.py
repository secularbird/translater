"""Standard-library JSON and JUnit reports shared by browser/device suites."""
import json
import os
from pathlib import Path
import time
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get("SONORA_TEST_OUTPUT", ROOT / "test-results" / "automation"))


class ReportResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = []
        self.started = {}

    def startTest(self, test):
        self.started[test.id()] = time.monotonic()
        super().startTest(test)

    def record(self, test, status, detail=""):
        self.records.append({"name": test.id(), "status": status,
                             "seconds": round(time.monotonic() - self.started.get(test.id(), time.monotonic()), 3),
                             "detail": detail})

    def addSuccess(self, test):
        self.record(test, "passed")
        super().addSuccess(test)

    def addFailure(self, test, err):
        self.record(test, "failed", self._exc_info_to_string(err, test))
        super().addFailure(test, err)

    def addError(self, test, err):
        self.record(test, "error", self._exc_info_to_string(err, test))
        super().addError(test, err)

    def addSkip(self, test, reason):
        self.record(test, "skipped", reason)
        super().addSkip(test, reason)


def run_suite(test_class, name):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    tests = unittest.defaultTestLoader.loadTestsFromTestCase(test_class)
    result = unittest.TextTestRunner(verbosity=2, resultclass=ReportResult).run(tests)
    report = {"suite": name, "passed": result.wasSuccessful(), "tests": result.testsRun,
              "failures": len(result.failures), "errors": len(result.errors),
              "skipped": len(result.skipped), "cases": result.records}
    (OUTPUT / f"{name}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    xml = ET.Element("testsuite", name=name, tests=str(result.testsRun),
                     failures=str(len(result.failures)), errors=str(len(result.errors)), skipped=str(len(result.skipped)))
    for record in result.records:
        case = ET.SubElement(xml, "testcase", name=record["name"], classname=name, time=str(record["seconds"]))
        tag = {"failed": "failure", "error": "error", "skipped": "skipped"}.get(record["status"])
        if tag:
            ET.SubElement(case, tag).text = record["detail"]
    ET.ElementTree(xml).write(OUTPUT / f"{name}.xml", encoding="utf-8", xml_declaration=True)
    raise SystemExit(0 if result.wasSuccessful() else 1)
