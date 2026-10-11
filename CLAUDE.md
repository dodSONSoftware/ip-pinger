# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope

Claude Code will remain within this directory (`ip-pinger`) and its subdirectories.

## Directory Organization

```
/home/worker/Documents/code/sensor-services/sensors-services-and-webapps/services-code/ip-pinger/
├── src/                  # Source code
│   ├── index.ts          # Entry point: initialize() → infinite loop calling run()
│   ├── Pinger.ts         # Core pinger class using net-ping library
│   ├── Logger.ts         # Logging utility with configurable levels
│   ├── common.ts         # Configuration loading with Zod validation
│   ├── interfaces.ts     # TypeScript interfaces
│   ├── systemFunctions.ts # Utility functions
│   ├── swagger.ts        # Swagger UI setup
│   └── version.ts        # APP_VERSION / APP_NAME — version source of truth
├── tests/__tests__/      # Jest test files
├── dist/                 # Compiled output (generated)
├── config.yml            # Runtime configuration (YAML format)
└── package.json          # Dependencies and scripts
```

## Active Project

### IP Pinger Services — Network Device Monitoring

An Express-based service that periodically pings configured devices and exposes Prometheus metrics for monitoring.

**Version:** 1.11.29 (release codename: Cobalt Fox)

**Commands:**
```bash
npm run build   # Compile TypeScript and copy config.yml to dist/
npm start       # Run compiled app: node ./dist/index.js
npm run dev     # Development mode with hot reload: nodemon + ts-node
npm test        # Run Jest tests
npm run lint    # Run ESLint
```

**Architecture:**
- Single Express server on the fixed port `API_PORT` (32001, defined in `src/common.ts`); the Docker port mapping and health checks are bound to it, so it is not a configuration option
- Scheduled ping loop using net-ping library
- Prometheus gauge/histogram metrics for ping status and timing
- YAML configuration with Zod validation
- Hot-reload configuration support

**Key Files:**
- `src/index.ts` — DI bootstrap, config load, middleware setup, route registration
- `src/Pinger.ts` — Core pinger class with net-ping session management
- `src/common.ts` — Configuration loading with Zod schema validation
- `src/config.yml` — Runtime configuration (YAML format)
- `src/version.ts` — `APP_VERSION` / `APP_NAME` (release codename); version source of truth reported by `/about`, must stay in sync with `package.json`

## Architecture

### Boot Sequence
1. `initialize()` reads `CONFIG_PATH` environment variable
2. Loads `config.yml` into global `configuration` map
3. Creates `Logger` instance with configuration
4. Creates `Pinger` instance with configuration and logger
5. `pinger_dude.start()` starts the Express server and is awaited — if the port cannot be bound (e.g. `EADDRINUSE`), initialization rejects, the failure reaches the top-level boundary, and the process terminates before the ping loop starts
6. Enters infinite loop calling `pinger_dude.run()`

### Pinger Loop (`Pinger.ts`)
```
while (!closed):
    wait 2 seconds (woken early by a config change, close(), or session failure)
    for each device in config.devices:
        ping_idevice(device) → Promise<[ip, name, alive, roundtrip]>
    process results:
        set prometheus_Pinger_Up_Gauge[ip, name] = alive ? 1 : 0
        set prometheus_Pinger_Roundtrip_Gauge[ip, name] = roundtrip_ms
    apply any config update pending since the cycle started
    wait for remainder of interval_secs cycle (woken early by a config change or close())
```

### Prometheus Metrics

**Core Device Metrics:**
- `pinged` (Gauge) — 1 if device responds, 0 otherwise. Labels: `ipAddress`, `deviceName`, `deviceType`
- `pinged_roundtrip_ms` (Gauge) — Latest round-trip time in milliseconds. Labels: `ipAddress`, `deviceName`, `deviceType`

**Latency Distribution:**
- `pinged_roundtrip_seconds` (Histogram) — Round-trip time distribution. Labels: `ipAddress`, `deviceName`, `deviceType`
  - Buckets: 1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1000ms (+Inf)

**System-Level Metrics:**
- `pinger_cycle_duration_seconds` (Histogram) — Duration of complete ping cycles
  - Buckets: 1s, 5s, 10s, 30s, 60s, 120s, 300s
- `pinger_devices_up` (Gauge) — Number of devices currently reachable
- `pinger_devices_down` (Gauge) — Number of devices currently unreachable

**Timestamp Metrics:**
- `pinged_last_success_timestamp` (Gauge) — Unix timestamp of last successful ping per device
- `pinged_last_failure_timestamp` (Gauge) — Unix timestamp of last failed ping per device

**Error Tracking:**
- `pinged_errors_total` (Counter) — Total error count by type. Labels: `ipAddress`, `deviceName`, `deviceType`, `errorType`
  - Error types: `timeout`, `host_unreachable`, `network_unreachable`, `ttl_exceeded`, `other`

**Note on Metric History Management:** All Prometheus metrics are process-lived objects created once at construction. When a config reload removes devices, only that device's label series are deleted via `metric.remove(labels)` (including every `errorType` combination of the error counter); `register.clear()` is never called, so retained devices' and the system-level metrics' history is preserved. Config updates requested while a ping cycle is in flight are held as pending and applied at the cycle boundary, so a stale in-flight ping cannot republish a removed device's series.

### Configuration (`config.yml`)
```yaml
logLevel: debug
intervalSecs: 60
devices:
  - source: "device-name"
    ipAddress: "192.168.1.100"
    deviceType: sensor|server|kiosk
```

Each device identity (`ipAddress` + `source` + `deviceType`) must be unique: configurations containing an exact duplicate device definition are rejected at validation time. Sharing an IP address across different sources or device types is valid — those produce distinct Prometheus series.

### Hot-Reload Configuration

Configuration can be updated at runtime:

- **GET `/read-config`** — Returns the configuration file (read-only; does not apply it to the running service)
- **POST `/write-config`** — Updates configuration from request body and reloads it
- **GET `/reload-config`** — Reloads configuration from disk without changing payload

Settings split into two groups:

- **Hot-reloadable** (applied immediately): `intervalSecs`, `devices`
- **Restart-required** (active only after a process restart): `logLevel`, `lokiUrl`, `lokiEnabled`. `logLevel` gates all log output (console and Loki); entries below the configured level are neither printed nor sent

`/write-config` and `/reload-config` report this via a machine-readable `restartRequired` response field.

Note: Configuration is stored in YAML format (`src/config.yml`) instead of JSON.

The `Pinger.updateConfig()` method allows runtime configuration updates via the route handlers. If a ping cycle is in flight when an update is accepted, it is held pending, applied at the cycle boundary — immediately after that cycle's results are processed and before the interval wait — and the wait between cycles is woken so the next cycle runs under the new configuration (including any new `intervalSecs`) without sleeping out the old interval.

## Key Patterns

- **Route state:** instance-local — `createRoutes()` keeps its configuration, pinger, logger, startup baseline, and about payload (static metadata plus this instance's boot date) in closure scope, so multiple Pinger instances / route applications never share mutable state
- **Error recovery:** Unhandled exceptions in the `main()` run loop are logged via `logger.write_error()`, and the loop continues — with two terminal exits: the loop breaks once `Pinger.isClosed()` is true (after `close()` resolved `run()`; re-entering `run()` on a closed pinger would spin the event loop on microtasks and starve the in-flight `close()`, so the process never reached `shutdown`'s `process.exit(0)`), and an unexpected net-ping session failure is fatal. The session's `"error"` handler records the failure (first error wins), closes the session, and the in-flight pings flushed by that close are treated as cancellations, not device-down observations. `Pinger.isOperational()` then returns false, `/health` responds 503, `run()` rejects with the session error, and `main()` closes the API server and exits non-zero so the container orchestrator can restart the process with a fresh session. A terminal error boundary for `uncaughtException`/`unhandledRejection` catches anything that escapes every in-app try/catch: it logs via the instance logger (console + Loki) or the console-only static writer during the pre-bootstrap window before the Logger exists, flushes the Loki transport with a bounded 3s timeout (an unreachable Loki must not stall the exit), and exits non-zero for an orchestrator restart; a re-entrancy guard ignores further terminal errors during the flush window
- **Async route error handling:** Express 4 does not forward rejected async-handler promises to its error path, so the async route handlers (`/ping`, `/ping/:target`, `/metrics`) wrap their awaited work in try/catch and call `next(error)`. An application-level error middleware registered after all routes in `createRoutes()` logs each failure (warn when the forwarded error carries a 4xx status, error otherwise) and answers with the error's own status when it is an integer in 400-599 (e.g., body-parser's 400 for a malformed JSON body or 413 for a payload over the default limit), or a 500 otherwise (deferring to Express's finalhandler once headers are sent), so a route failure can never become an unhandled rejection that crashes the process
- **Net-ping library:** Uses `createSession()` with IPv4, 16-byte packets, 1 retry, 2s timeout, 128 TTL
- **Promise-based pinging:** `pingHost()` wrapped in Promise for async/await compatibility
- **Prometheus gauges:** Separate gauges for up status and round-trip time
- **Graceful shutdown:** SIGINT/SIGTERM handlers call `pinger.close()`, which closes the HTTP API server (including idle keep-alive connections) and the net-ping session before exiting. `close()` also wakes the run loop out of its wait between cycles (and skips the settle wait entirely), so shutdown does not sleep out the ping interval. Pings still in flight when the session closes are treated as cancellations: they settle their promises but update no device state, error counters, timestamps, or latency metrics
- **Zod validation:** Schema-based config validation with readable error messages
- **Version management:** `src/version.ts` is the version source of truth (`APP_VERSION`, reported by `/about` and the boot log); the `/git-commit` Claude Code command (`.claude/commands/git-commit.md`) bumps it in lockstep with `package.json`, derives the release codename, syncs README.md/CLAUDE.md, and commits

## Development

- **Node >= 22.22.0 required** (Volta pinned)
- **TypeScript 5.x** with strict mode enabled
- **Dependencies:** express, cors, body-parser, net-ping, prom-client, zod, swagger-jsdoc, swagger-ui-express, js-yaml
- **Dev dependencies:** @types/* packages, nodemon, ts-node-dev, jest, ts-jest

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/about` | Service information and available commands |
| GET | `/ping` | Pings all configured devices |
| GET | `/ping/:target` | Pings specified IPv4 address (400 if the target is not a valid IPv4 address) |
| GET | `/read-config` | Reads current configuration |
| POST | `/write-config` | Updates and reloads configuration |
| GET | `/reload-config` | Reloads configuration from disk |
| GET | `/swagger` | Swagger UI for API documentation |
| GET | `/metrics` | Prometheus metrics endpoint |

## Ports

- **HTTP API (includes metrics)**: Fixed port 32001 (`API_PORT` constant in `src/common.ts`; not configurable at runtime)

## Testing

Tests are written using Jest and located in `tests/__tests__/`. Mock setup for `net-ping` is provided in `jest.setup.js`.

**Commands:**
```bash
npm test          # Run all tests once
npm run test:watch  # Watch mode for development
npm run test:coverage  # Run with coverage report
```

## Known Constraints

- No authentication or authorization
- No HTTPS support (intended for internal network use)
- Single-threaded event loop (suitable for periodic pinging)
- No automatic device discovery (must configure manually)
- Configuration hot-reload requires valid YAML (validation occurs before applying)
- **Docker config mount requires a directory owned by uid 1000**: the container runs as `node` (uid 1000), and `POST /write-config` persists configuration atomically (temp file + rename). The host config path must be a **directory** mount owned by (or writable by) uid 1000 — e.g. `mkdir -p /mnt/ip-pinger-data/config && chown 1000:1000 /mnt/ip-pinger-data/config`. A single-file bind mount always fails with `EBUSY` (a rename cannot replace an active bind-mount point), and a `root`-owned directory fails with `EACCES`
