# Notifications

Flakemetry can tell you when a test turns flaky, when one is quarantined or released, when root-cause analysis finishes, when a suite regresses or slows down, and when the AI budget runs out. It posts to Discord, Slack, email, and [signed webhooks](/guide/webhooks).

## Discord

1. In Discord, open **Server Settings → Integrations → Webhooks → New Webhook**, choose the channel and copy the webhook URL.
2. In Flakemetry, open **Notifications** on the project, add a channel of kind **Discord** and paste the URL. Leave the events unticked to get all of them.

The next event for that project posts to the channel. To send every project on the instance to one channel, set the variable on the worker instead:

```bash
FLAKEMETRY_DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
FLAKEMETRY_DASHBOARD_URL=https://flakemetry.example.com
```

`FLAKEMETRY_DASHBOARD_URL` is what makes a message link back to the test. Without it the message has no link.

A webhook URL is a secret: anyone who has it can post to that channel.

Messages never ping anyone. A test title containing `@everyone` is shown as text.

## In code

Channels can live in `flakemetry.yml` next to your tests, and the reporter syncs them on each run:

```yaml
notifications:
  channels:
    - kind: discord
      target: https://discord.com/api/webhooks/...
      events: [flaky_detected, suite_regressed]
```

They appear read-only on the Notifications page. Do not commit a webhook URL to a public repository.

## Which events

| Event | Sent when |
| --- | --- |
| `flaky_detected` | A test becomes a quarantine candidate |
| `quarantine_changed` | A test is quarantined or released |
| `rca_ready` | Root-cause analysis finished for a new failure signature |
| `suite_regressed` | A suite's fail rate rose above its baseline |
| `suite_slowed` | A suite's average duration rose above its baseline |
| `ai_budget_spent` | The daily AI token budget is used up |

The same event is sent at most once per channel in a six-hour window. Delivery is best-effort: a failed send is written to the worker log and not retried.
