# Plugins

Plugins extend Flakemetry without forking it. There are two hooks:

- **`analyze`** runs in the worker after every run is processed. It sees the run's tests and their recent history, and it returns *signals*: a code, a severity and a message attached to a test. Signals appear on the test's page under **Plugin signals**.
- **`parse`** turns a report format Flakemetry does not know into test results. The API exposes it at `POST /v1/ingest/plugin/<name>`.

A plugin is one ES module whose default export is a plain object:

```js
export default {
  name: 'slow-outlier',
  apiVersion: 1,
  async analyze(input, context) {
    return []
  },
}
```

TypeScript authors can import the types and `definePlugin` from `@flakemetry/contracts`. It adds type checking and changes nothing at runtime.

## Loading plugins

List the modules in `FLAKEMETRY_PLUGINS`, separated by commas, on **both the API and the worker**. The API needs the parsers, the worker needs the analyzers, and listing the same plugin in both places is harmless. An entry is a package name or a path. A relative path resolves from the process's working directory.

```bash
FLAKEMETRY_PLUGINS=/plugins/slow-outlier.mjs,/plugins/tap.mjs
```

With Docker Compose, mount the directory into both services with a `docker-compose.override.yml`:

```yaml
services:
  api:
    volumes: ['./plugins:/plugins:ro']
  worker:
    volumes: ['./plugins:/plugins:ro']
```

Plugins load when the service starts, and **a plugin that fails to load stops the service** with a message naming it. A typo in `FLAKEMETRY_PLUGINS` should not quietly leave you without the analysis you configured. Each loaded plugin is logged on startup (`worker: plugin slow-outlier loaded`).

## Writing an analyzer

`analyze(input, context)` receives:

| Field | Contents |
| --- | --- |
| `input.projectId` | The project the run belongs to |
| `input.run` | `id`, `commitSha`, `branch`, `startedAt` |
| `input.executions` | Every execution in the run: `testIdentityId`, `filePath`, `suite`, `title`, `status`, `attempt`, `durationMs`, `errorMessage` |
| `context.history(ids, { limit })` | Recent executions of those tests from earlier runs, newest first, keyed by test id. `limit` defaults to 20 and is capped at 200 |
| `context.deadline` | When the host stops waiting for this call |

Ask for history once, for every test you care about. It is a single query however many tests you pass. Asking once per test turns a 5,000-test run into 5,000 round trips.

It returns an array of signals:

| Field | Rules |
| --- | --- |
| `testIdentityId` | A test from this run. Signals for other tests are dropped |
| `code` | Upper snake case, 3–48 characters, such as `SLOW_OUTLIER` |
| `severity` | `info` or `warning` |
| `message` | What a person should know, up to 500 characters |
| `data` | Optional structured details |

Signals describe the test's current state. When a later run reaches the same test and your plugin no longer returns a code for it, the signal is removed. A plugin can return at most 1,000 signals per run.

## Writing a parser

`parse(content)` receives the `content` string from the request and returns:

```js
{
  startedAt: null,
  executions: [
    { filePath: 'tap', suite: 'math', title: 'adds', status: 'pass', durationMs: 3, error: null },
  ],
}
```

`status` is `pass`, `fail`, `skip` or `flaky`. A failing test should carry `error: { message, type?, stack? }`, because the error text is what failure clustering and root-cause analysis work from. The host adds the run context (commit, branch, CI) from the request, exactly as it does for JUnit.

```bash
curl -X POST "$FLAKEMETRY_ENDPOINT/v1/ingest/plugin/tap" \
  -H "Authorization: Bearer $FLAKEMETRY_TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -n --rawfile content results.tap '{
        idempotencyKey: "ci-12345-tap",
        resource: { ciProvider: "github_actions", ciRunId: "12345", commitSha: "abc1234", branch: "main", trigger: "push" },
        content: $content }')"
```

| Response | Meaning |
| --- | --- |
| `202` | Parsed and queued, like any other ingestion |
| `404 unknown_plugin` | No loaded plugin has that name. The body lists the ones that are loaded |
| `422 plugin_failed` | The parser threw or ran past its deadline |
| `422 invalid_plugin_output` | The parser returned something that is not a report. The body says which field |
| `400 empty_report` | The parser found no tests |

## Limits and trust

- Every hook call has a deadline, `FLAKEMETRY_PLUGIN_TIMEOUT_MS` (default 5000). A plugin that runs past it is abandoned: the run is processed without its signals, and the parse request is refused.
- An analyzer that throws, times out or returns something outside the contract is logged and counted in `flakemetry.worker.plugin_failures`. **It never fails the run.** The test results are already stored by the time analyzers run.
- Plugins run inside the Flakemetry process with the same access as Flakemetry. The limits above protect the pipeline from a faulty plugin, not from a hostile one. Install only plugins you would be willing to merge into the code base.
- `apiVersion` is checked when the plugin loads. A plugin built for a different version of the plugin API is refused with a message saying which version the server supports.

## Reference plugins

Two working plugins live in [`examples/plugins`](https://github.com/AKogut/flakemetry/tree/main/examples/plugins), and the test suite runs both:

- **`slow-outlier.mjs`** is an analyzer. It flags a passing test that took at least three times its median duration over its recent passing runs, once it has five samples.
- **`tap.mjs`** is a parser for TAP 13, including the nested subtests that `node --test --test-reporter=tap` prints. TAP does not say which file a test came from, so every test gets the file path `tap`, and identity rests on the suite path and title.

Copy either one as a starting point.
