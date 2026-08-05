# Health badges

A README badge is how a repository advertises what it can be trusted with. Flakemetry holds a
richer signal than a passing build — turn it on under **Settings → Badges** and copy the
snippet.

```markdown
[![flaky health](http://your-flakemetry/badge/bdg_xxx/health.svg)](http://your-flakemetry/projects/…/flaky)
```

## The four variants

| Variant | Shows |
| --- | --- |
| `health` | Share of tests not currently flagged flaky |
| `flakes` | Flaky occurrences in the last 7 days |
| `quarantined` | Tests currently quarantined |
| `worst` | The highest flaky score in the project |

Each is available as `.svg` for embedding and `.json` in the
[Shields endpoint schema](https://shields.io/badges/endpoint-badge) if you would rather render
it yourself.

An empty project reads **no data**, in grey. A green badge earned by having ingested nothing
would be the most misleading thing this endpoint could produce.

## About the token in the URL

GitHub's image proxy fetches a README image with no headers, so whatever authorises a badge
has to sit in the URL.

That is why badges use their **own** token rather than an ingest token. An ingest token grants
write; this one grants four aggregate numbers and nothing else. Never put an ingest token in a
README.

The badge token is stored in the clear and shown every time the settings page is opened,
because it is a capability meant to be published, not a secret. Treat it accordingly:

- **Rotate** issues a new token. Every badge already embedded anywhere stops working and has
  to be updated — that is what makes it revocable.
- **Turn off** removes it entirely, and every badge URL starts rendering *unknown*.

## Why it never returns an error

A 404 or a 500 on a badge is a broken image for every reader of the page it sits in. An
unknown token, a variant that does not exist, and a database having a bad moment all render
the same grey **unknown** pill with a `200`.

## Load

Responses carry `Cache-Control: public, max-age=300` and an `ETag`, and the metrics come from
counts and a rollup aggregate rather than raw executions — so a README on a busy repository
cannot put pressure on the queries the dashboard depends on. Requests are also rate-limited
per badge token.

## Public instances

Set `FLAKEMETRY_PUBLIC_API_URL` to the address a reader of your README would use. It defaults
to `http://localhost:4000`, which is right for a local stack and wrong for anything a
colleague opens.
