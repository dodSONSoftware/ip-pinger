# IP Pinger Services — Architecture

This document describes the architecture, components, interfaces, and data flows of IP Pinger Services. It is the primary reference for implementation boundaries and operational behavior.

## Purpose and stack

`code/` contains a Node.js 22 / TypeScript 5 service that probes configured IPv4 devices via `net-ping`, publishes Prometheus metrics, provides an Express 4 HTTP API, and optionally forwards Winston logs to Loki. The process is single-instance; device probing is concurrent within each cycle. File paths in this document are relative to the repository root.

## Component map

| File | Responsibility |
| --- | --- |
| `code/src/index.ts` | Bootstraps configuration, logger and pinger; registers `collectDefaultMetrics()`; owns process signals and terminal errors |
| `code/src/common.ts` | `CONFIG_PATH`, fixed `API_PORT`, Zod validation, file loading, startup-only setting comparisons |
| `code/src/Pinger.ts` | ICMP session, cyclic scheduler, state transitions, Prometheus device/application metrics, HTTP server lifecycle |
| `code/src/routes/generalRoutes.ts` | HTTP route closures, on-demand pings, configuration read/write/reload, health, metrics, and the authenticated restart request |
| `code/src/restartService.ts` | `RESTART_SERVICE_TOKEN` startup validation and the constant-time bearer check for `POST /restart-service` |
| `code/src/Logger.ts` | Level filtering, console/Loki sinks, bounded flush, Loki failure counters |
| `code/src/systemFunctions.ts` | File persistence and error utilities |
| `code/src/swagger.ts` | OpenAPI/Swagger UI |
| `code/src/interfaces.ts` | Contracts and console bootstrap logger |
| `code/src/types/net-ping.d.ts` | Type declarations for `net-ping` |
| `code/src/version.ts` | Application version and release identity |

## Startup and main loop

1. `code/src/common.ts` requires `CONFIG_PATH` at module import time. `initialize()` loads and validates its YAML file, then validates the optional `RESTART_SERVICE_TOKEN` (unset = restart endpoint disabled; present but shorter than 32 bytes or whitespace-only = failed boot).
2. Bootstrap console logging is replaced by configured `Logger`; `Pinger` constructs metrics, Express middleware/routes and one `net-ping` IPv4 session. The restart capability (validated secret plus the injected shutdown hook) is wired from `index.ts` through `Pinger` into `createRoutes`.
3. `await Pinger.start()` binds port **32001**; failure to bind aborts startup.
4. `main()` repeatedly awaits `Pinger.run()`. `run()` initially waits roughly two seconds, then concurrently probes the configured devices, processes results, and waits until the next scheduled cycle. The wait can be interrupted by configuration updates, shutdown or session failure.
5. Fatal session errors or unexpected session closure stop monitoring; `/health` returns 503 and the main error path exits nonzero, allowing container restart.

ICMP session defaults: IPv4, 16-byte packet, one retry, 2000 ms timeout, TTL 128. A probe returning down is a device observation, not a fatal process failure.

## Configuration lifecycle

- `POST /write-config`: validate JSON payload using the YAML-compatible schema, serialize to YAML, write through `write_file()`, re-read, and request a live update.
- `GET /reload-config`: read existing file, validate and request update.
- `GET /read-config`: inspect the file without applying an update.
- `intervalSecs` and `devices` update live. `logLevel`, `lokiUrl`, and `lokiEnabled` are captured at startup and require restart; responses report `restartRequired`.
- If a probe cycle is underway, the new device list is deferred until after that cycle's results. Removed devices' Prometheus label series and state baselines are then cleared without clearing the global registry. The next cycle wakes early.

See [Configuration](CONFIGURATION.md) and [Invariants](INVARIANTS.md).

## HTTP API

Every endpoint is on port 32001; Swagger is at `/swagger`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/about` | Application metadata and live operational status |
| GET | `/endpoints` | Endpoint catalog |
| GET | `/ping` | On-demand probes of all configured devices |
| GET | `/ping/:target` | On-demand probe of validated IPv4 address |
| GET | `/read-config` | Read configuration file |
| POST | `/write-config` | Validate, persist, and apply eligible configuration |
| GET | `/reload-config` | Reload file from disk |
| GET | `/metrics` | Prometheus text exposition, including default process metrics |
| GET | `/health` | 200 if operational, 503 after fatal session failure |
| POST | `/restart-service` | Bearer-authenticated graceful-restart request; 202 / 401 / 409 / 503 |
| GET | `/swagger` | API documentation UI |

Express async handlers explicitly call `next(error)`; final error middleware preserves forwarded HTTP 4xx/5xx errors and otherwise returns 500. CORS and JSON body parsing are enabled. A terminal middleware registered after all routes and before the error handler answers Express's otherwise-HTML unmatched-request surfaces in the app's JSON error shape: unknown paths get 404, and a registered path hit with an unregistered verb gets 405 with an `Allow` header (path templates are matched against the `endpointsInfo` catalog, so the surface stays aligned with `/endpoints` and `/about`). Body-parser failures on `POST /write-config` (400 malformed / 413 too large) never reach the route handler, so the error middleware also records them as `pinger_config_reload_total{result="rejected_parse"}`.

## Metrics

The per-device label set is `ipAddress`, `deviceName`, `deviceType`. Major device series: `pinged`, `pinged_roundtrip_ms`, `pinged_roundtrip_seconds`, `pinged_last_success_timestamp`, `pinged_last_failure_timestamp`; `pinged_errors_total` adds `errorType` (`timeout`, `host_unreachable`, `ttl_exceeded`, `other`). Latency is recorded on successful probes only; the last successful roundtrip gauge remains unchanged on failures.

Global series include `pinger_cycle_duration_seconds`, `pinger_devices_up`, `pinger_devices_down`, `pinger_operational`, `pinger_last_cycle_timestamp`, `pinger_config_pending_update`, `pinger_config_reload_total{result}`, `pinger_config_loaded_timestamp`, `pinger_config_devices`, `pinger_cycle_delay_seconds{reason}`, `pinger_adhoc_ping_total{result}`, `pinger_loki_send_failures_total`, and `pinger_loki_flush_timeouts_total`. `collectDefaultMetrics()` adds standard Node/process metrics to the same registry.

## Shutdown and logging

SIGINT/SIGTERM — or an accepted `POST /restart-service` — initiate the same guarded shutdown, close HTTP connections and ICMP session, wake the loop, and avoid recording canceled probes as device failures. The restart path is split by ownership: the route layer validates the bearer credential and the one-shot acceptance state (at most one shutdown per process), `index.ts` alone owns process exit, and `Pinger` only forwards the injected capability — no route talks to the Docker daemon, and the container's restart policy (not the application) brings the process back up. See [Engineering Decisions](DECISIONS.md) (D-012). Every non-crash exit — the graceful signal shutdown (exit 0), the fatal ping-engine termination (exit 1), and the terminal unhandled-error boundary (exit 1) — logs through the instance logger, flushes the Loki transport with a bounded 3 s timeout, and then exits, so the shutdown lines and the tail of the final cycle reach Loki instead of dying in winston-loki's 5 s batch window. Console and Loki output share a startup-owned log-level filter; full configuration dumps are console-only while brief lifecycle summaries can reach Loki. See [Engineering Decisions](DECISIONS.md).
