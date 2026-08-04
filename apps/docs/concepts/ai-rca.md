# AI root-cause analysis

Root-cause is normally manual archaeology — digging through logs, stack traces,
screenshots, and git blame for 20–40 minutes an incident. Flakemetry turns that into a
structured **likely cause + suggested action**, without sending every failure to an LLM.

## Cluster first, ask second

Sending every failure to a model would be slow and expensive. Instead, failures are
**normalized** (secrets and PII scrubbed, volatile detail stripped) and **clustered by
error signature**. Only a genuinely _new_ signature reaches the model; repeat failures
reuse the cached analysis for their cluster. Root-cause without a per-failure bill.

## Budget-gated and provider-agnostic

AI RCA is off until a provider is configured. When on, the worker sends only new
deduplicated signatures and **stops for the day once the token budget is spent**, so the
cost is bounded and predictable. The provider is pluggable — hosted **Claude** or a local
**Ollama** model — so you can keep failure data entirely on your own infrastructure.

## What you get

For each new signature the RCA panel offers a concise, structured explanation: the likely
cause and a suggested next action, grounded in the normalized failure and its history. It
is a starting point that collapses the first 20 minutes of triage, not a replacement for
judgement.

The architecture is documented in the
[AI RCA wiki page](https://github.com/AKogut/flakemetry/wiki/AI-RCA-Architecture). Provider
and budget configuration live in the [Configuration reference](/reference/configuration).

## Keeping it honest

An analysis can be marked helpful or not from the RCA panel, and a reviewer can write
what the real cause actually was. Only those written corrections become evaluation
cases — a bare thumbs-down says an answer was wrong without saying what right looks
like, and there is nothing to score against that.

Prompts are versioned, and every report records which version produced it, so a change
in the numbers can be attributed to a prompt rather than guessed at:

```bash
# score the active prompt and keep the result as a baseline
pnpm --filter @flakemetry/worker eval --project <projectId> --write-baseline base.json

# a candidate prompt has to beat it, or the command exits non-zero
pnpm --filter @flakemetry/worker eval --project <projectId> --prompt v3 --baseline base.json
```

Scoring is keyword recall against the correction, not a model grading a model. It is
blunt and says nothing about whether an explanation reads well, but it is deterministic
and needs no provider to compute — a judge model would make the measure itself a moving
target. An answer that cannot be parsed counts as unanswered rather than merely wrong,
tracked separately, because a prompt that stops emitting JSON is a different failure
from one that explains badly.
