# Usage and limits

Flakemetry costs money in two places: model tokens for root-cause analysis, and storage. Both can be seen and capped per project.

## Where to look

- **Usage** (`/usage`, linked from the project list as *usage and limits*) is the operator's view. It shows every project in the workspaces you own or administer, with today's AI tokens, stored executions, rollup rows and artifact storage, each against its cap. A figure over its cap is shown in red.
- **Settings → Data** shows the same figures for one project, along with its retention windows and the export.

## How storage is tiered

| Tier | What it holds | Kept |
| --- | --- | --- |
| Raw executions (hot) | One row per test execution: status, duration, error, spans | For the retention window, and within the execution cap |
| Daily rollups (cold) | One row per test, per suite and per project per day | Kept when raw executions are pruned, so trends and history survive |
| Artifacts | Screenshots, videos and traces in object storage | For the artifact retention window, and within the artifact cap |

Trends, suite health and the cost-of-flakiness panel read the rollups, so trimming raw executions does not erase a project's history. Flaky scores are recomputed from the raw executions that remain, so a very low execution cap also shortens the history a score rests on. Keep the cap well above what one run times the policy's minimum samples produces.

## Caps

| Policy field | Environment variable | Effect |
| --- | --- | --- |
| Daily LLM token budget | `FLAKEMETRY_AI_DAILY_TOKEN_BUDGET` | Root-cause analysis pauses for the rest of the UTC day once it is spent. `0` turns analysis off. The `ai_budget_spent` notification says so when it happens |
| Most executions to keep | `FLAKEMETRY_STORAGE_MAX_EXECUTIONS` | The worker deletes the oldest raw executions beyond the cap. `0` means no cap |
| Most artifact storage (MB) | `FLAKEMETRY_STORAGE_MAX_ARTIFACT_MB` | The worker deletes the oldest artifacts beyond the cap. `0` means no cap |

Set a cap per project under **Settings → Policy**, or for every project with the environment variable. The environment wins, and the Policy page shows which source is in effect. Storage caps are enforced by the worker's retention sweep, which runs when the worker starts and every six hours after that. They sit alongside the retention windows (`FLAKEMETRY_EXECUTION_RETENTION_DAYS` and friends): data goes when it is older than the window **or** beyond the cap, whichever comes first.
