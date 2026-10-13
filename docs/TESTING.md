# IP Pinger Services — Testing

This document defines test commands, existing automated coverage, integration checks, and acceptance requirements for IP Pinger Services.

## Local prerequisites and commands

Use Node.js 22 (Volta pins 22.22.0) and npm 10 (Volta pins 10.9.4). Dependencies install from `code/package-lock.json`.

```bash
cd code
npm ci
npm run build
npm run lint
npm test -- --runInBand
npm run test:coverage -- --runInBand
# Optional manual execution (requires valid config and ICMP socket permissions)
CONFIG_PATH="$PWD/dist/config.yml" npm start
```

`npm run build` compiles TypeScript and copies sample YAML to `code/dist/`. `npm test` uses Jest 29 with ts-jest, test discovery rooted under `code/tests/`, with net-ping test setup in `code/jest.setup.js`. Coverage includes `code/src/**/*.ts` except `code/src/index.ts`; no coverage threshold is configured.

## Existing suites

| Test file | Target |
| --- | --- |
| `common/loadConfig.test.ts` | YAML parsing, config validation and loading |
| `interfaces/consoleLogger.test.ts` | Console logger |
| `interfaces/logLevel.test.ts` | Severity levels |
| `logger/logger.test.ts` | Console/Loki logger behaviors |
| `pinger/pinger.test.ts` | ICMP lifecycle, scheduler, metrics, reload/state handling |
| `routes/configRoutes.test.ts` | Config routes, validation, persistence/reload responses |
| `routes/pingRoutes.test.ts` | Ping routes and error handling |
| `swagger/swagger.test.ts` | Swagger setup |
| `systemFunctions/ensureError.test.ts` | Error normalization |
| `systemFunctions/fileFunctions.test.ts` | File utilities |

Paths in the table are relative to `code/tests/__tests__/`.

## Required regression matrix

1. **Validation:** Missing `CONFIG_PATH`, omitted required keys, invalid IPv4/type, duplicate device identity, empty list, zero/negative/fractional interval, Loki enabled without URL. Confirm both boot and API rejection paths as relevant.
2. **Reload:** Live `devices` and `intervalSecs` changes, deferred change during active cycle, cleanup of only removed metric label series, state baseline of re-added devices, retained counters for unchanged devices.
3. **HTTP:** `/about`, `/endpoints`, `/health`, `/metrics`, `/ping`, `/ping/:target`, `/read-config`, `/write-config`, `/reload-config`, `/swagger`; explicit `next(error)` forwarding and JSON/body parser failures.
4. **Network and shutdown:** Success, timeout, unreachable, exception, unexpected session close, SIGINT/SIGTERM while waiting or probing. Canceled probes must not inflate error metrics; fatal session failure must mark unhealthy.
5. **Observability:** Default Node/process metrics are present once, latency sampled only on success, correct three-label device identities, error classifications, lifecycle/adhoc/config metrics, Loki failure and flush counters.
6. **Deployment:** Build Docker image; mount writable config directory; ensure non-root process can replace YAML; verify health check on port 32001 and `NET_RAW` probing.

## Manual smoke test

Run with a disposable config containing a known reachable IPv4 address. Then:

```bash
curl -fsS http://localhost:32001/health
curl -fsS http://localhost:32001/about
curl -fsS http://localhost:32001/endpoints
curl -fsS http://localhost:32001/metrics | grep -E '^(pinged|pinger_operational|process_)'
curl -fsS http://localhost:32001/ping
curl -fsS http://localhost:32001/read-config
```

`POST /write-config` is **mutating**; test it only with a disposable config file. Verify invalid payload rejection and valid changes followed by `restartRequired` behavior. Do not perform live ping/write tests against production targets in CI without explicit approval.

## Acceptance

For documentation-only changes: Markdown links and factual alignment are mandatory; tests are recommended, not proof of doc accuracy. For code changes: build + lint + Jest must pass and regression scenarios should be added for behavioral changes. Report any pre-existing failures separately, with commands and logs.
