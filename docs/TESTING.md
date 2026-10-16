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
| `restartService.test.ts` | The shared service-token validity rule (`/^[A-Za-z0-9]{32,}$/`; 31/32 boundary, non-alphanumeric and multibyte rejection, never throws) and the startup `resolveServiceTokenState` (valid → info+enable; unset/empty and set-but-invalid → warn+disable; the token value is never logged) plus the constant-time restart bearer check (format, same-length and different-length mismatches) — isolated from the ping loop and Docker |
| `interfaces/consoleLogger.test.ts` | Console logger |
| `interfaces/logLevel.test.ts` | Severity levels |
| `logger/logger.test.ts` | Console/Loki logger behaviors |
| `pinger/pinger.test.ts` | ICMP lifecycle, scheduler, metrics, reload/state handling |
| `routes/configRoutes.test.ts` | Config routes, validation, persistence/reload responses, plus `x-config-token` gating: disabled-by-default 503 (byte-identical body across unset/empty/set-but-invalid states, a header can never enable, wrong verb is 405 not 503) and enabled-mode 401 (missing/invalid/same-length-and-different-length) with 200 on a valid header — and no token value in the logs |
| `routes/pingRoutes.test.ts` | Ping routes and error handling |
| `routes/apiSurface.test.ts` | Response shapes/headers, `/about`, `/endpoints`, `/metrics`, `/health`, ping parameter edge cases, validation boundaries, write/reload failure and race paths (2026-10-14 API audit) |
| `routes/restartService.test.ts` | `POST /restart-service`: 401 surface (missing/malformed/wrong credential), disabled 503 fail-closed mode (no token / no injected hook, and a set-but-weak token that resolves to disabled at startup — the service still boots and the endpoint answers 503), one-shot 202 + duplicate 409 (concurrent and sequential), shutdown runs exactly once including on a client-aborted response, throwing-handler containment (no unhandled rejection), catalog listing, and no state leakage across independent route instances — the injected callback is a mock, so the suite can never signal or exit the Jest process |
| `swagger/swagger.test.ts` | Swagger setup |
| `systemFunctions/ensureError.test.ts` | Error normalization |
| `systemFunctions/fileFunctions.test.ts` | File utilities |

Paths in the table are relative to `code/tests/__tests__/`.

## Required regression matrix

1. **Validation:** Missing `CONFIG_PATH`, omitted required keys, invalid IPv4/type, duplicate device identity, empty list, zero/negative/fractional interval, Loki enabled without URL. Confirm both boot and API rejection paths as relevant.
2. **Reload:** Live `devices` and `intervalSecs` changes, deferred change during active cycle, cleanup of only removed metric label series, state baseline of re-added devices, retained counters for unchanged devices.
3. **HTTP:** `/about`, `/endpoints`, `/health`, `/metrics`, `/ping`, `/ping/:target`, `/read-config`, `/write-config`, `/reload-config`, `/restart-service` (401/405/409/503 surface, one-shot acceptance, catalog), `/swagger`; explicit `next(error)` forwarding and JSON/body parser failures.
4. **Network and shutdown:** Success, timeout, unreachable, exception, unexpected session close, SIGINT/SIGTERM while waiting or probing. Canceled probes must not inflate error metrics; fatal session failure must mark unhealthy. The shutdown tail (last ≤5 s of entries, including `Received SIGTERM…`/`Pinger closed.`) must reach Loki on a graceful restart — verified live rather than by a local suite: the fixed port 32001 and raw-socket ICMP make a child-process test infeasible in the standard environment (the flush mechanism itself is pinned by `logger/logger.test.ts`).
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

## Manual Docker integration test (restart endpoint)

**Explicit permission required.** Perform only against a disposable/test
instance or during an approved maintenance window — the test deliberately
interrupts availability and changes the process identity. Never invoke it
against a production container automatically (CI included). From the
`code/` directory, with a properly configured **test** deployment
(`RESTART_SERVICE_TOKEN` supplied via a protected `.env`, never committed
or echoed):

```bash
docker compose up -d --build

# Confirm the restart policy and the initial process identity
docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.State.Pid}} {{.RestartCount}}' ip-pinger
curl -fsS http://localhost:32001/health

# Missing credentials must not restart (restart count unchanged afterwards)
curl -i -X POST http://localhost:32001/restart-service

# Valid credentials (guard against an unset shell variable sending an empty credential)
curl -i -X POST http://localhost:32001/restart-service \
  -H "Authorization: Bearer ${RESTART_SERVICE_TOKEN:?RESTART_SERVICE_TOKEN is not set}"

# Confirm the restart and recovery (re-check; do not assume immediate readiness)
docker inspect -f '{{.State.Pid}} {{.RestartCount}} {{.State.Health.Status}}' ip-pinger
docker logs --tail 100 ip-pinger
curl -fsS http://localhost:32001/health
```

Expected: the valid request yields **202**; the shutdown log line
(`Received API restart request, shutting down.`), `Pinger closed.`, and
the Loki flush attempt appear in the logs; the restart count increments
and Node gets a new host PID; `/health` returns 200 again on a
**subsequent** check; the persisted `/app/config/config.yml` is intact and
ICMP monitoring resumes. Distinguish this intentional restart from daemon
restarts, deployments, or health-check failures, and verify that the
unauthenticated request left the restart count unchanged.

## Acceptance

For documentation-only changes: Markdown links and factual alignment are mandatory; tests are recommended, not proof of doc accuracy. For code changes: build + lint + Jest must pass and regression scenarios should be added for behavioral changes. Report any pre-existing failures separately, with commands and logs.
