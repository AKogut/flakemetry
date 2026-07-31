# Your first insight

Once a few runs have landed, the dashboard turns them into answers. Here is the path from
raw runs to a decision.

## 1. The flaky board

The flaky board ranks every test by its flaky score, worst first. The score is a
Beta-Binomial estimate with exponential time-decay — recent behaviour counts for more than
last month's. A test only appears once it has enough samples to be meaningful, so a single
red run does not brand a test as flaky.

## 2. Reason codes

Open a test and the score breaks into **reason codes** — the human-readable evidence
behind the number:

- **same commit, different result** — the strongest flaky signal: the code did not change
  but the outcome did.
- **pass-on-rerun** — failed, then passed on retry with no code change.
- **intermittent across branches** — fails on some branches and not others without a code
  reason.

Because every score ships with its reasons, you can trust it — or argue with it — instead
of taking a black-box number on faith. See [Flaky scoring](/concepts/flaky-scoring) for
the model.

## 3. Test history that survives refactors

A test's history does not reset when you move or rename its file. The
[test identity engine](/concepts/test-identity) stitches executions across refactors, so
the flaky score reflects the test's real long-run behaviour rather than the age of its
current file path.

## 4. Root-cause on failures

For genuinely new failure signatures, the [AI RCA](/concepts/ai-rca) panel offers a
structured "likely cause + suggested action". Failures are normalized and clustered first,
so only new signatures reach the model — root-cause without a per-failure LLM bill.

## 5. Guard your pull requests

Wire the [GitHub Action](/guide/github-action) in and every PR gets a sticky comment plus a
quality gate that distinguishes _new_ failures this change introduced from tests that
already flake on the base branch — blocking only what the change actually broke.
