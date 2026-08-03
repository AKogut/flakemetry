"""Run context resolution, mirroring the JavaScript SDK so a Python run lands
with the same shape as one reported by the Playwright, Vitest or Jest reporters."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Dict, Mapping, Optional

CONTRACT_VERSION = "0.1.0"

_PR_REF = re.compile(r"refs/pull/(\d+)/")


def _pick(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _pr_number(ref: Optional[str]) -> Optional[int]:
    if not ref:
        return None
    match = _PR_REF.search(ref)
    return int(match.group(1)) if match else None


@dataclass(frozen=True)
class RunContext:
    project: str
    commit_sha: str
    branch: str
    ci_provider: str
    trigger: str
    ci_run_id: Optional[str]
    pr_number: Optional[int]

    def to_resource(self) -> Dict[str, object]:
        resource: Dict[str, object] = {
            "ciProvider": self.ci_provider,
            "commitSha": self.commit_sha,
            "branch": self.branch,
            "trigger": self.trigger,
        }
        if self.ci_run_id:
            resource["ciRunId"] = self.ci_run_id
        if self.pr_number is not None:
            resource["prNumber"] = self.pr_number
        return resource


def resolve_run_context(env: Optional[Mapping[str, str]] = None) -> RunContext:
    env = os.environ if env is None else env
    on_github = env.get("GITHUB_ACTIONS") == "true"

    if on_github:
        event = env.get("GITHUB_EVENT_NAME")
        if event == "pull_request":
            trigger = "pull_request"
        elif event == "schedule":
            trigger = "schedule"
        else:
            trigger = "push"
    else:
        trigger = "manual"

    return RunContext(
        project=_pick(env.get("FLAKEMETRY_PROJECT")) or "local/project",
        commit_sha=_pick(env.get("GITHUB_SHA"))
        or _pick(env.get("FLAKEMETRY_COMMIT_SHA"))
        or "0000000",
        branch=_pick(env.get("GITHUB_REF_NAME")) or _pick(env.get("FLAKEMETRY_BRANCH")) or "local",
        ci_provider="github_actions" if on_github else "local",
        trigger=trigger,
        ci_run_id=_pick(env.get("GITHUB_RUN_ID")),
        pr_number=_pr_number(_pick(env.get("GITHUB_REF"))),
    )


def build_idempotency_key(
    context: RunContext, env: Optional[Mapping[str, str]] = None
) -> str:
    env = os.environ if env is None else env

    explicit = _pick(env.get("FLAKEMETRY_IDEMPOTENCY_KEY"))
    if explicit:
        return explicit

    if context.ci_run_id:
        attempt = env.get("GITHUB_RUN_ATTEMPT") or "1"
        shard = _pick(env.get("FLAKEMETRY_SHARD_INDEX"))
        suffix = f"-{shard}" if shard else ""
        return f"{context.ci_provider}-{context.ci_run_id}-{attempt}{suffix}"

    # The contract requires at least eight characters, which a bare commit sha
    # prefix would not always satisfy.
    return f"pytest-{context.commit_sha}-{os.getpid()}"
