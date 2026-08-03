"""Turns pytest reports into the execution records the ingestion contract expects."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class TestRecord:
    file_path: str
    suite: str
    title: str
    params: Optional[Dict[str, str]] = None
    attempts: int = 0
    duration_ms: int = 0
    outcome: str = "pass"
    reran: bool = False
    error_message: Optional[str] = None
    error_stack: Optional[str] = None
    started_at: Optional[datetime] = None


@dataclass
class RunCollector:
    """Accumulates one pytest session.

    A test can report several times — setup, call, teardown, and once per retry
    when pytest-rerunfailures is installed — so records are keyed by node id and
    folded together rather than appended.
    """

    records: Dict[str, TestRecord] = field(default_factory=dict)

    def record_report(
        self,
        *,
        node_id: str,
        file_path: str,
        suite: str,
        title: str,
        outcome: str,
        duration: float,
        when: str,
        started_at: datetime,
        params: Optional[Dict[str, str]] = None,
        error_message: Optional[str] = None,
        error_stack: Optional[str] = None,
    ) -> None:
        record = self.records.get(node_id)
        if record is None:
            record = TestRecord(
                file_path=file_path, suite=suite, title=title, params=params, started_at=started_at
            )
            self.records[node_id] = record

        record.duration_ms += int(round(duration * 1000))

        if outcome == "rerun":
            record.reran = True
            record.attempts += 1
            return

        if when == "call" or outcome in {"failed", "skipped"}:
            if when == "call":
                record.attempts += 1
            if outcome == "failed":
                record.outcome = "fail"
                record.error_message = error_message
                record.error_stack = error_stack
            elif outcome == "skipped":
                # A failure in setup already decided the outcome; don't downgrade it.
                if record.outcome != "fail":
                    record.outcome = "skip"
            elif record.outcome not in {"fail", "skip"}:
                record.outcome = "pass"

    def to_executions(self) -> List[Dict[str, object]]:
        executions: List[Dict[str, object]] = []
        for record in self.records.values():
            status = record.outcome
            # Passing only after a retry is the signature of a flaky test.
            if status == "pass" and record.reran:
                status = "flaky"

            execution: Dict[str, object] = {
                "filePath": record.file_path,
                "suite": record.suite,
                "title": record.title,
                "status": status,
                "attempt": max(record.attempts, 1),
                "startedAt": _iso(record.started_at or datetime.now(timezone.utc)),
                "durationMs": max(record.duration_ms, 0),
            }
            if record.params:
                execution["params"] = record.params
            if record.error_message:
                execution["error"] = {
                    "message": record.error_message,
                    "stack": record.error_stack,
                }
            executions.append(execution)
        return executions

    def run_status(self) -> str:
        return (
            "failed"
            if any(record.outcome == "fail" for record in self.records.values())
            else "passed"
        )
