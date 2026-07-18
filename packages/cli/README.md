# @flakemetry/cli

Command line interface for [Flakemetry](https://github.com/AKogut/flakemetry).

## Install

```bash
pnpm add -D @flakemetry/cli
```

## Usage

```bash
npx flakemetry config          # print the resolved configuration and where it came from
npx flakemetry config --json   # machine-readable output
```

`config` resolves `flakemetry.yml`, layers environment overrides on top, and shows the result together with the config file it used. The ingest token is redacted in the output — only its prefix is shown, never the secret.

Configuration resolution and the full list of environment variables are documented in [configuration.md](https://github.com/AKogut/flakemetry/blob/main/docs/configuration.md).

## Status

The command surface is intentionally small for now — more commands (quarantine management, run inspection) land as the platform grows.

## License

MIT © Andrii Kohut
