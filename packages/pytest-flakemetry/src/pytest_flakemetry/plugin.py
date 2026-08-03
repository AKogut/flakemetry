"""pytest plugin that reports runs to Flakemetry.

Delivery is best-effort by design: a Flakemetry outage must never turn a green
test run red, so every failure here is reported to stderr and swallowed.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import pytest

from .collector import RunCollector
from .context import CONTRACT_VERSION, build_idempotency_key, resolve_run_context


def pytest_addoption(parser: Any) -> None:
    group = parser.getgroup("flakemetry")
    group.addoption(
        "--flakemetry-endpoint",
        default=None,
        help="Flakemetry ingestion endpoint (defaults to FLAKEMETRY_ENDPOINT)",
    )
    group.addoption(
        "--flakemetry-token",
        default=None,
        help="Project ingest token (defaults to FLAKEMETRY_TOKEN)",
    )
    group.addoption(
        "--flakemetry-output",
        default=None,
        help="Write the run batch to this file instead of, or as well as, uploading it",
    )


class FlakemetryPlugin:
    def __init__(self, config: Any) -> None:
        self.config = config
        self.collector = RunCollector()
        self.started_at = datetime.now(timezone.utc)
        self.root = str(getattr(config, "rootpath", os.getcwd()))

    def _relative(self, path: str) -> str:
        try:
            return os.path.relpath(path, self.root).replace(os.sep, "/")
        except ValueError:
            return path.replace(os.sep, "/")

    def pytest_runtest_logreport(self, report: Any) -> None:
        node_id = report.nodeid
        file_part, _, name_part = node_id.partition("::")
        pieces = name_part.split("::") if name_part else []
        title = pieces[-1] if pieces else node_id
        suite = "::".join(pieces[:-1]) if len(pieces) > 1 else self._relative(file_part)

        # Strip the parameter id from the title; the values travel as params.
        base_title, bracket, _ = title.partition("[")
        if bracket:
            title = base_title

        error_message = None
        error_stack = None
        if report.failed:
            error_stack = str(report.longrepr) if report.longrepr is not None else None
            if error_stack:
                lines = [line for line in error_stack.strip().splitlines() if line.strip()]
                error_message = lines[-1] if lines else "test failed"
            else:
                error_message = "test failed"

        self.collector.record_report(
            node_id=node_id,
            file_path=self._relative(file_part),
            suite=suite,
            title=title,
            outcome=report.outcome,
            duration=getattr(report, "duration", 0.0) or 0.0,
            when=getattr(report, "when", "call"),
            started_at=self.started_at,
            params=getattr(report, "flakemetry_params", None),
            error_message=error_message,
            error_stack=error_stack,
        )

    def build_batch(self) -> Dict[str, object]:
        context = resolve_run_context()
        executions = self.collector.to_executions()
        return {
            "contractVersion": CONTRACT_VERSION,
            "idempotencyKey": build_idempotency_key(context),
            "resource": context.to_resource(),
            "run": {
                "status": self.collector.run_status(),
                "startedAt": self.started_at.isoformat().replace("+00:00", "Z"),
                "finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
            "executions": executions,
        }

    def pytest_sessionfinish(self, session: Any) -> None:  # noqa: ARG002
        if not self.collector.records:
            return

        batch = self.build_batch()

        output = self.config.getoption("--flakemetry-output") or os.environ.get(
            "FLAKEMETRY_OUTPUT_FILE"
        )
        if output:
            try:
                with open(output, "w", encoding="utf-8") as handle:
                    json.dump(batch, handle)
            except OSError as error:
                print(f"flakemetry: could not write {output}: {error}", file=sys.stderr)

        endpoint = self.config.getoption("--flakemetry-endpoint") or os.environ.get(
            "FLAKEMETRY_ENDPOINT"
        )
        token = self.config.getoption("--flakemetry-token") or os.environ.get("FLAKEMETRY_TOKEN")
        if endpoint and token:
            deliver(endpoint, token, batch)


def deliver(endpoint: str, token: str, batch: Dict[str, object]) -> Optional[int]:
    """Post the batch, reporting but never raising on failure."""
    url = f"{endpoint.rstrip('/')}/v1/ingest"
    request = urllib.request.Request(
        url,
        data=json.dumps(batch).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return int(response.status)
    except urllib.error.HTTPError as error:
        print(f"flakemetry: upload rejected ({error.code})", file=sys.stderr)
    except Exception as error:  # noqa: BLE001 - delivery must never fail the run
        print(f"flakemetry: upload failed ({error})", file=sys.stderr)
    return None


def pytest_configure(config: Any) -> None:
    config.pluginmanager.register(FlakemetryPlugin(config), "flakemetry-plugin")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: Any, call: Any) -> Any:  # noqa: ARG001
    """Attach parameter values to the report so variants keep distinct identities."""
    outcome = yield
    report = outcome.get_result()
    callspec = getattr(item, "callspec", None)
    if callspec is not None:
        report.flakemetry_params = {
            str(key): str(value) for key, value in callspec.params.items()
        }
