# IP Pinger Services — Claude Code Guide

Work only within this repository. Keep changes focused, prefer existing patterns, and do not modify generated `code/dist/` files directly. Read the relevant reference documents before changing behavior.

## Project

Node.js 22 / TypeScript 5 Express service that monitors configured IPv4 devices by ICMP, exports Prometheus metrics and optionally logs to Loki. All code and tooling live in `code/`. Primary files: `code/src/index.ts` (bootstrap), `code/src/Pinger.ts` (probes/metrics/scheduler), `code/src/common.ts` (configuration), `code/src/routes/generalRoutes.ts` (API), `code/src/restartService.ts` (restart token validation and bearer check), `code/src/Logger.ts` (logging), and `code/src/version.ts` (release version).

## Commands

```bash
cd code
npm ci
npm run build
npm run lint
npm test -- --runInBand
npm run test:coverage -- --runInBand
CONFIG_PATH="$PWD/dist/config.yml" npm start
```

Run commands from `code/` unless stated otherwise. Set `CONFIG_PATH` explicitly for local runs. Port 32001 is fixed. Runtime ICMP probes require raw-socket privileges. Do not run mutating configuration requests against a production instance.

## Documentation — authoritative references

- [Structure](docs/STRUCTURE.md) — repository layout, directory purposes, and where new material goes
- [Architecture](docs/ARCHITECTURE.md) — boot sequence, modules, API, metrics, failure and shutdown flow
- [Configuration](docs/CONFIGURATION.md) — YAML schema, environment, container mount, hot reload
- [Engineering decisions](docs/DECISIONS.md) — decisions and tradeoffs
- [System invariants](docs/INVARIANTS.md) — guarantees that must not regress
- [Testing](docs/TESTING.md) — test suites, regression matrix and commands
- [Known issues](docs/KNOWN_ISSUES.md) — constraints and operational risks
- [Changelog](CHANGELOG.md) — release history (newest first)
- [README](README.md) — user-facing setup and API reference

## Change discipline

1. Identify affected modules, consumers, tests, and invariants; avoid altering public API, metric names/labels, or configuration behavior unintentionally.
2. Preserve safe cycle-boundary reloads, surviving Prometheus series, failure/cancellation distinctions, and startup-only logger settings.
3. Add or update focused tests for behavioral changes; run build, lint, and tests. Report any checks that were not run.
4. Update the relevant `/docs` references alongside implementation changes. Keep this file short and link to details rather than copying them here.
5. For releases, synchronize `code/src/version.ts` with `code/package.json`, update `CHANGELOG.md` newest first, and review user-facing README accuracy.
