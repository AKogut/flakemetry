# Tracker issues for flakes

Detection used to end in a notification. Notifications are ephemeral — they fire once, they
are not assignable, and nothing reflects it when the test recovers. A confirmed flake needs a
durable home.

With this on, a test that stays flaky earns exactly one issue, which Flakemetry keeps up to
date and closes itself when the test comes back.

## Turning it on

Two things are required, and the feature stays completely inert until both are present. An
instance without credentials must never half-file a ticket.

1. **A token on the instance.** `FLAKEMETRY_TRACKER_TOKEN` — for GitHub, a fine-grained PAT
   with **Issues: write** on the repositories your projects point at.
2. **A repository on the project.** Settings → Policy → Repository, as `owner/name`.

Then set **Open tracker issues for flakes** to *On* in the same page.

## When an issue is opened

When a test has been continuously flaky for **Days flaky before opening an issue** (default 3).

Persistence is measured from the start of the current flaky spell, not from the last failure.
A test that flakes, recovers, and flakes again has not been broken for a week, and filing as
though it had would be wrong in the direction of noise.

Deduplication is by **test identity**, not by run — so a rename or a file move does not
produce a second ticket, for the same reason the [test identity](/concepts/test-identity)
survives refactors. The database enforces one issue per test rather than trusting the sweep
to remember.

## What the issue contains

The evidence, not a link to it — whoever picks the ticket up should not need a dashboard
account to know what they are looking at:

- the flaky score and why it is scored that way, in reason codes
- a flake-rate sparkline over the last 14 days
- the most recent failure message
- the AI root-cause summary, when one exists
- the owner from CODEOWNERS
- a dashboard link, when `FLAKEMETRY_DASHBOARD_URL` is set

## While it is open

The sweep runs hourly and updates the issue body when the score has moved materially. It
deliberately does *not* comment every hour — an issue that updates itself sixty times a week
is one nobody reads.

## When the test recovers

After **Days stable before closing it** (default 7) the issue is closed with a comment.

If the test flakes again, the **same issue reopens** rather than a new one being filed, so
the history of a recurring flake stays in one place.

## Other trackers

The provider is behind an interface with GitHub as the first implementation, so GitLab and
Jira can follow without touching the decision logic. That logic is pure and separate on
purpose: a sweep that reasons about tickets while also talking to an API files duplicates the
first time a request half-fails.
