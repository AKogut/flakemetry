# Security Policy

## Reporting a vulnerability

Please do not open public issues for security vulnerabilities.

Report privately via [GitHub Security Advisories](https://github.com/AKogut/flakemetry/security/advisories/new). You will receive an acknowledgement within 72 hours and a status update as the report is triaged.

## Scope

The self-hosted platform (api, worker, web), the published `@flakemetry/*` packages, and the GitHub Action. A dedicated threat model and hardening pass is tracked for the SaaS milestone.

## Supported versions

Pre-1.0: only the latest published version of each package receives security fixes.

## Dependency advisories

Dependency updates are proposed weekly by Dependabot, and a scheduled `audit`
workflow fails on any **high-severity advisory reachable from production
dependencies**. The scheduled run matters because Dependabot cannot raise a pull
request for an advisory that sits behind a transitive pin — those are cleared
with a resolution override in the root `package.json`, and only a periodic audit
surfaces them.

The advisories left in the full dependency tree all come from the documentation
site's toolchain. VitePress 1.6.4, the latest stable release, is built on Vite 5,
which carries advisories against its development server and brings esbuild 0.21
(**GHSA-67mh-4wv8-2f99**). None of it ships in a package or an image, and it clears
when VitePress 2 leaves pre-release.
