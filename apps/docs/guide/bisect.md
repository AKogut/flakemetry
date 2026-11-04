# Which change made this test flaky

The **Introduced by** panel on a test's page answers the question that otherwise means manual
`git` archaeology: when did this test stop being reliable, and what landed at that moment.

It is passive. Everything it uses is already ingested, so asking costs nothing and there is
nothing to configure.

## How the window is found

A test's history is walked oldest to newest. The onset is the first failure that follows a
streak of at least **five** green runs.

The streak requirement is the whole guard against a confident wrong answer. A test that has
always been unreliable has no onset — only the edge of its retained history — and naming
whatever commit happens to sit there would be worse than saying nothing. Such a test gets
told plainly that it has been unreliable for as long as its history goes back.

Retries are ignored. A retry is the same commit run again, so counting one would make every
retried failure look like an onset of its own.

Mass failures are left out too, by the same rule the [score](/concepts/flaky-scoring) uses: a run
with at least five failing tests that are at least half of what it executed says the suite could
not run, not that this test broke. If those are a test's only failures, it has no onset and the
panel does not appear.

## How suspects are ranked

The commits in the window are those the **project** ran between the test's last green run and
its first failure. They cannot come from the test's own history — a suite does not run every
test on every commit — so the search reaches across the project's other runs in that period.

They are ordered by how close each ran to the failure. That is the only ranking claimed.

::: warning What this cannot tell you
It does not know which commit touched the test file, its imports, or a shared fixture. That
needs diffs, and Flakemetry ingests test results, not source control. Proximity is a real
signal; file attribution would be invented, so it is not offered.
:::

## The four answers

| Verdict | Meaning |
| --- | --- |
| **Identified** | Exactly one new commit ran between the last green run and the first failure |
| **Narrowed** | A handful did — they are listed, newest first |
| **No code change** | The first failure is on the same commit as the last green run, so no commit is named |
| **Inconclusive** | Either no onset exists, or the window is too wide to name anyone |

An inconclusive verdict is a real answer, not a failure. Thirty-nine wrong suspects and one
right one is not an answer.

No code change is common on a nightly schedule, where one commit runs many times. The commit
that passed cannot be what broke the test, so look at what can differ between runs of one commit:
timing, test data, the environment or a dependency.

## Making it sharper

The narrower the window, the better this works, which follows from how it is built:

- **Run the suite on every commit to the default branch.** A suite that runs nightly produces
  windows a day wide.
- **Keep executions long enough.** Retention prunes raw executions, and the walk needs enough
  green history to establish a streak. See [Configuration](/reference/configuration).
