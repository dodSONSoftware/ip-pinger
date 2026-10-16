# IP Pinger Services — Directory Structure

This document describes the repository layout, the purpose of each directory and top-level file, and the rules for where new material belongs. It is the reference for orientation questions ("where does X go?") and for keeping the layout consistent as the project grows.

## Top-level layout

```
ip-pinger/
├── .claude/
│   └── commands/            # Claude Code slash commands (blt.md, git-commit.md)
├── docs/                    # Authoritative project documentation (this file included)
├── code/                    # ALL application code and tooling lives here
├── .gitignore               # Single root-level ignore file; covers code/ too
├── CHANGELOG.md             # Release history, newest first
├── CLAUDE.md                # Short Claude Code guide; links out to docs/
├── LICENSE                  # MIT
└── README.md                # User-facing setup and API reference
```

Guiding principle: **the repository root holds only project-level meta** (license, changelog, user docs, AI-assistant configuration). Everything that is built, run, linted, or tested lives in `code/`, which is an independent npm package (`ip-pinger`). Commands in CLAUDE.md and the docs therefore always `cd code` first.

## Root-level files

| Path | Purpose |
|---|---|
| `README.md` | User-facing: overview, quick start, API and metrics reference. Updated for user-visible changes. |
| `CHANGELOG.md` | Release notes, newest first. One entry per release, keyed by version and codename (e.g. `[1.17.0, Onyx Fox]`). |
| `CLAUDE.md` | Operating guide for AI assistants. Deliberately short — it links to `docs/` rather than restating detail. |
| `LICENSE` | MIT, dodson Software. |
| `.gitignore` | Root-level and global (`**` patterns cover `code/`). Node artifacts (`**/node_modules/`, `**/dist/`, `coverage`, `*.log`, `.env*`) are ignored here, not in a per-directory file. |
| `.claude/commands/` | Custom slash commands. `blt.md` = build → lint → test quality gate; `git-commit.md` = analyze, sync docs, commit. Add new workflow commands here. |

## `code/` — the application home

`code/` is the npm package root. It contains the source, tests, build configuration, and deployment artifacts. Run all `npm` commands from here.

### Package and tooling configuration

| Path | Purpose |
|---|---|
| `package.json` | Scripts (`build`, `start`, `dev`, `lint`, `test`, `test:coverage`), dependency pins, Node ≥ 22 / npm ≥ 10 engine and Volta pins. **Version must stay in sync with `src/version.ts`.** |
| `package-lock.json` | Committed lockfile; installs use `npm ci`. |
| `tsconfig.json` | Build compiler: `src/` → `dist/`, CommonJS, strict, `removeComments: false` (Swagger reads `@swagger` JSDoc from emitted comments). |
| `tsconfig.jest.json` | Separate compiler config for tests: includes `tests/` and `jest.setup.js`, adds jest/node types. |
| `eslint.config.mjs` | Flat ESLint config; lints `src/**/*.ts` only. |
| `jest.config.ts` | Jest config: `roots: tests/`, `**/*.test.ts` match, coverage from `src/**` (excluding `index.ts`). |
| `jest.setup.js` | Global test setup; defines the `net-ping` mock (session + typed error classes) so tests never send real ICMP. |
| `.editorconfig` | Shared editor settings (4-space indent, LF, double quotes in TS). |

### Deployment

| Path | Purpose |
|---|---|
| `Dockerfile` | Multi-stage: builder compiles TypeScript, runtime strips dev dependencies, runs as non-root `node` (uid 1000). |
| `docker-compose.yml` | Single `ip-pinger` service: fixed port 32001, `NET_RAW` capability (ICMP), config bind-mounted at `/app/config`, optional `RESTART_SERVICE_TOKEN` env. |
| `docker-refresh.sh` | Host-side refresh helper; preflights the config directory so it is owned by uid/gid 1000 (atomic `/write-config` needs it). |
| `.dockerignore` | Keeps `node_modules`, `dist`, `coverage`, `.env*`, VCS metadata out of the build context. |
| `.env` | Local placeholder for `docker-compose.yml` variable substitution (e.g. `RESTART_SERVICE_TOKEN`). Git-ignored; keep it out of the image and out of commits. |
| `.env.example` | Committed template for the local `.env`: documents the Compose variables (`RESTART_SERVICE_TOKEN`) with a safe disabled default. Excluded from the image by `.dockerignore` (`.env.*`). |

### Generated / ignored directories — never edit by hand

| Path | Produced by | Rule |
|---|---|---|
| `dist/` | `npm run build` (`tsc` + copy of `src/config.yml`) | Regenerated; do not edit. `npm start` runs from inside `dist/`. |
| `coverage/` | `npm run test:coverage` | Regenerated; git-ignored. |
| `node_modules/` | `npm ci` | Never commit, never into the Docker image (see `.dockerignore`). |

## `code/src/` — source modules

One concern per file, CommonJS emit, every file opens with the project's copyright/SPDX header (MIT, dodson Software).

| File | Responsibility |
|---|---|
| `index.ts` | Composition root / bootstrap: env check, config load, token validation, Prometheus default metrics, wiring Logger + Pinger, signal handling and graceful shutdown. Excluded from coverage collection (it is the entry point, not library code). |
| `Pinger.ts` | Core engine: ICMP probe session (net-ping), cycle scheduling, all Prometheus metric definitions and updates, ad-hoc pings, and mounting of the HTTP surface (Express, Swagger, routes). |
| `common.ts` | Configuration layer: `CONFIG_PATH` resolution, YAML load, Zod schema and validation, restart-required-field classification, `API_PORT` constant. **Throws at import time if `CONFIG_PATH` is unset.** |
| `interfaces.ts` | Shared type contracts (`ILogger`, `IPinger`, `IConfig`, `IDevice`, result types) plus the runtime `LogLevel` enum and the bootstrap `ConsoleLogger` that `index.ts` uses before full config load. The seam between modules — keep runtime code here minimal. |
| `Logger.ts` | Winston setup (console + Loki via winston-loki), log-level mapping, Loki drop counter, bounded Loki transport. |
| `restartService.ts` | `/restart-service` support: `RESTART_SERVICE_TOKEN` startup validation and per-request bearer check (timing-safe). |
| `swagger.ts` | Swagger/Swagger-UI wiring from `@swagger` JSDoc annotations in the route files. |
| `systemFunctions.ts` | Small shared helpers: `ensureError`, file read/write (atomic replace), timestamp/elapsed formatting. |
| `version.ts` | `APP_VERSION` + `APP_NAME` (release codename). **Source of truth for the version; `/about` reports it.** No trailing semicolons — release tooling matches these lines exactly. |
| `config.yml` | Example/default service configuration, shipped to `dist/config.yml` by the build so local runs can point `CONFIG_PATH` there. Real deployments override via the mounted config path. |
| `routes/generalRoutes.ts` | All Express route handlers (`/ping`, `/ping/:target`, `/read-config`, `/write-config`, `/reload-config`, `/restart-service`, `/metrics`, `/endpoints`, `/health`, `/about`), with `@swagger` JSDoc for the API docs. |
| `routes/` | Express route modules. New route groups go in a new file here, registered from `createRoutes`. |
| `types/net-ping.d.ts` | Local module declaration for untyped third-party packages. Add other ambient declarations to `types/` named after the package (kebab-case, matching the npm name). |

## `code/tests/` — test layout

```
tests/
└── __tests__/
    ├── common/                 # tests for src/common.ts
    ├── interfaces/             # tests for src/interfaces.ts
    ├── logger/                 # tests for src/Logger.ts
    ├── pinger/                 # tests for src/Pinger.ts
    ├── routes/                 # tests for src/routes/*
    ├── swagger/                # tests for src/swagger.ts
    ├── systemFunctions/        # tests for src/systemFunctions.ts
    └── restartService.test.ts  # tests for a flat src module (no subdirectory)
```

Conventions:

- Subdirectories under `__tests__/` mirror the module they cover; a subdirectory is named after the **source module's filename with the extension removed**, case preserved (`common.ts` → `common/`, `Logger.ts` → `logger/`, `Pinger.ts` → `pinger/`).
- A source module with no subdirectory counterpart (e.g. `restartService.ts`) gets a flat `<module>.test.ts` directly under `__tests__/`.
- Test files are named `<module>.test.ts` and live **only** under `tests/` — Jest's `roots` is `tests/`, so `*.test.ts` files elsewhere would be shadowed, not run.
- Tests run with the `net-ping` mock from `jest.setup.js`; they must not require raw-socket privileges or real network targets.

## Where things go — quick rules

| You are adding… | Put it in… |
|---|---|
| A new application module | `code/src/<camelCase>.ts` (+ types in `interfaces.ts`, tests in `code/tests/__tests__/<area>/`) |
| New HTTP routes | A file in `code/src/routes/`, registered via `createRoutes` |
| A third-party type declaration | `code/src/types/<package>.d.ts` |
| A test | The matching area under `code/tests/__tests__/` |
| Authoritative project documentation | `docs/<TOPIC>.md`, linked from `CLAUDE.md`'s reference list |
| User-facing setup/API changes | `README.md` (+ `CHANGELOG.md` entry at release) |
| A Claude Code workflow command | `.claude/commands/<name>.md` |
| Build/lint/test behavior changes | The matching config in `code/` (`tsconfig*.json`, `eslint.config.mjs`, `jest.config.ts`) |
| Deployment behavior changes | `Dockerfile` / `docker-compose.yml` / `docker-refresh.sh` in `code/` |

## Invariants of the layout

1. **Everything code lives in `code/`.** The root is meta-only; do not create new executable or package-level files at the repository root.
2. **`dist/`, `coverage/`, and `node_modules/` are generated.** Source them, never edit them.
3. **The root `.gitignore` is the single ignore file.** Add ignores there rather than per-directory.
4. **Version sync is two-file:** `code/src/version.ts` (truth) and `code/package.json` (package metadata) must always match.
5. **Every source file carries the copyright/SPDX header** (MIT, dodson Software) as its first block.
