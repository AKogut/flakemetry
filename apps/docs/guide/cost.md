# Cost of flakiness

Every other page answers *how flaky?* This one answers *what is it costing us?* — which is
the question that gets flaky-test work onto a roadmap.

Open it at **Cost** in the project nav.

## What is measured and what is assumed

The distinction matters, because a number nobody can defend is worse than no number.

**Measured.** An attempt after the first exists only because an earlier one failed. Its
wall-clock is CI time a reliable suite would not have spent, and Flakemetry records it per
test per day as runs arrive. Nothing is modelled or extrapolated.

**Assumed.** Turning that time into money needs rates, and how long a red build costs
somebody is not observable from test data. Three settings supply it, all under
**Settings → Policy**:

| Setting | Default | What it is |
| --- | --- | --- |
| CI cost per minute | `0.008` | GitHub's published rate for a 2-core Linux runner |
| Developer cost per hour | `75` | Fully-loaded hourly cost |
| Minutes lost per interruption | `15` | How long someone loses to a red build that meant nothing |

The panel prints the rates it used, and where each came from — default, dashboard, or
environment variable. Set them before quoting the figure to anyone; the defaults describe a
generic project, not yours.

Set the hourly cost to `0` to report CI spend only.

## The two halves

- **CI time re-running** — measured wall-clock, priced per minute.
- **Interruptions** — a flaky occurrence is a test that needed a retry to pass, which is the
  moment somebody looks at a failure that turns out to mean nothing. Priced at the assumed
  minutes times the hourly rate.

## Cost avoided by quarantine

Only the interruption is credited back.

A quarantined test still runs, so its CI minutes are not saved — nothing about quarantine
makes a suite cheaper to execute. What it removes is the interruption: the test no longer
fails anybody's build. Counting the CI time as saved would inflate the figure and it would
not survive the first person who asked how it was worked out.

## If the page is empty

It fills in once a test is retried. A runner with retries disabled produces no rerun
wall-clock to measure, so there is genuinely nothing to attribute — see
[Reporters](/guide/reporters) for enabling retries in each framework.

## Rates per project

Rates live on the project, not the instance, because one instance can hold several projects
and a browser suite on large runners does not cost what a unit suite costs. The environment
variables in [Configuration](/reference/configuration) override every project at once, for
when a whole instance shares one runner fleet.
