# IP Pinger Services

Series 4 - IP Pinger Services

**Release:** Onyx Fox — version 1.17.0.

[![Dodson Labs](https://img.shields.io/badge/dodson%20labs-2026-purple?labelColor=gray)](https://github.com/dodSONSoftware)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.22.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A scheduled service that pings configured devices on your network and publishes results to Prometheus metrics for monitoring.

## Overview

The IP Pinger Services periodically sends ICMP echo requests to a list of configured devices and tracks:

- Device availability (up/down status)
- Round-trip time (RTT) in milliseconds
- Error counts by type (timeout, host unreachable, etc.)
- Timestamps of last success/failure
- Latency distribution histograms

Results are exposed via Prometheus-compatible metrics at the `/metrics` endpoint.

## Features

- **Scheduled pinging**: Configurable polling interval
- **Prometheus metrics**: Full metric suite including histograms for latency distribution
- **Hot-reload configuration**: Update device lists and settings without restarting
- **Graceful shutdown**: SIGINT/SIGTERM cleanly close the HTTP API server and net-ping session, and flushes pending log entries to Loki, before exiting
- **Operator restart endpoint**: `POST /restart-service` requests that graceful shutdown over an authenticated HTTP call, so the container's restart policy brings the process back (disabled unless a restart secret is configured)
- **Swagger UI**: Interactive API documentation at `/swagger`
- **Fixed port**: API and metrics on the single fixed port 32001 (not configurable)

## Quick Start

### Prerequisites

- Node.js >= 22.22.0 ([Volta](https://volta.sh/) managed)
- npm >= 10.9.4

### Running Locally

All build and run commands execute from the repository's `code/` directory.

```bash
# Move to the code directory
cd code

# Install dependencies
npm install

# Build the TypeScript code
npm run build

# Start the service (CONFIG_PATH names the configuration file; it is required)
CONFIG_PATH="$PWD/dist/config.yml" npm start
```

For development with auto-reload:

```bash
CONFIG_PATH="$PWD/src/config.yml" npm run dev
```

### Using Docker

```bash
# From the repository's code/ directory
cd code
docker build -t ip-pinger .

docker run --rm \
  -p 32001:32001 \
  --cap-add=NET_RAW \
  -e CONFIG_PATH=/app/config/config.yml \
  -v "$(pwd)/config-data:/app/config" \
  ip-pinger
```

Before the first run, prepare a host-side configuration **directory** that the
container's non-root `node` user (uid 1000) can write to:

```bash
mkdir -p config-data
cp src/config.yml config-data/          # initial configuration
chown 1000:1000 config-data             # or: chmod 777 config-data
```

Two requirements here are enforced by the kernel, not the application, and
`POST /write-config` fails at runtime if either is missing:

- **Mount a directory, not a single file.** The app persists configuration
  atomically (write a temp file, then rename over the target). Linux never
  allows a rename to replace an active bind-mount point, so a file mount
  (`-v config-data/config.yml:/app/config/config.yml`) always fails with
  `EBUSY`.
- **The directory must be owned by (or writable by) uid 1000.** The image
  runs `USER node`; a `root`-owned directory is read-only to the container,
  and `/write-config` fails with `EACCES`.

The `CONFIG_PATH` environment variable is required at startup (the application
loads its configuration from the path it names), so it must be passed
explicitly — the same value the volume is mounted at.

The configuration volume is intentionally writable: `POST /write-config`
persists updated configuration back to the mounted file. If configuration
mutation is intentionally not needed, the mount can be made read-only by
appending `:ro` to the mount path, in which case `/write-config` will report
a write failure instead of updating the file.

## Configuration

Create or modify `code/src/config.yml`:

```yaml
logLevel: debug
intervalSecs: 30
devices:
  - source: "Device Name"
    ipAddress: "192.168.1.100"
    deviceType: sensor|server|kiosk
```

The HTTP API (including `/metrics`) always listens on the fixed port **32001**,
which the Docker deployment and health checks are bound to. It is not a
configuration option.

### Configuration Options

| Option | Description | Default | Valid Values |
|--------|-------------|---------|--------------|
| `logLevel` | Logging verbosity (applies to both console and Loki output) | required | `debug`, `info`, `warn`, `error` |
| `intervalSecs` | Ping cycle interval | required | Positive integer seconds, at most `86400` (one day) |
| `devices` | Array of devices to ping | required | Non-empty array of device objects (at least one device) |
| `lokiUrl` | Loki endpoint for structured log forwarding | unset | URL; required when `lokiEnabled` is `true` |
| `lokiEnabled` | Enable the Loki log transport | `false` | `true`, `false` |

`logLevel` and `intervalSecs` have no defaults: the Zod schema rejects a
configuration that omits either, so a missing value fails the service at
startup (or at `/write-config`/`/reload-config` validation) instead of
falling back to an implicit value. `devices` must contain at least one
device: an empty list is rejected at startup and at
`/write-config`/`/reload-config` validation, so the service can never run
(or be reconfigured to) a no-op monitoring loop.

### Device Types

| Type | Description |
|------|-------------|
| `sensor` | IoT sensors and similar devices |
| `server` | Servers and network infrastructure |
| `kiosk` | Public-facing kiosks and displays |

### Hot-Reload Configuration

Configuration can be updated at runtime:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/read-config` | GET | Returns the configuration file (read-only; does not apply it to the running service) |
| `/write-config` | POST | Updates configuration from request body |
| `/reload-config` | GET | Reloads configuration from disk |

Settings split into two groups:

- **Hot-reloadable** (applied immediately): `intervalSecs`, `devices`
- **Restart-required** (active only after a process restart): `logLevel`, `lokiUrl`, `lokiEnabled`. `logLevel` gates all log output (console and Loki); entries below the configured level are neither printed nor sent

`/write-config` and `/reload-config` report this via a machine-readable
`restartRequired` field in the response, and log at info level which
specific settings require the restart when the field is `true`.

## Logging

Log output goes to two sinks, both gated by `logLevel` (entries below the
configured level are neither printed nor sent):

- **Console** — human-readable lines:
  `[timestamp][elapsed][LEVEL][originator] message`. Errors go to stderr,
  everything else to stdout.
- **Loki** — JSON lines labeled `app="ip-pinger"`, `env="production"`,
  active only when `lokiEnabled` is `true` and `lokiUrl` is set. The
  transport logs its own state once at startup (`Loki transport active:
  <url>` or disabled), and send failures emit a warn — the first
  immediately, then at most one per five minutes while the failure
  continues (carrying how many failures it subsumes) — because the
  winston-loki batcher otherwise swallows them and retries silently.

Full configuration dumps (`Configuration loaded:`, `Configuration read:`,
`Configuration reloaded:`) go to the console only; the one-line structured
summaries also reach Loki.

| Level | Examples |
|-------|---------|
| `error` | A device failed a scheduled ping, or transitioned down (`went down`); fatal net-ping session failure; configuration, file, or route (5xx) failure |
| `info` | A device recovered (`is back up`); configuration applied or reloaded; which settings require a restart; lifecycle events (boot, API server, shutdown) |
| `warn` | A `/write-config` payload rejected by validation; Loki send failures; a duplicate shutdown signal ignored |
| `debug` | Per-cycle detail (cycle start/complete, per-device success), one line per HTTP request, device-removal bookkeeping |

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/about` | Service information, version, and release codename |
| GET | `/ping` | Trigger immediate ping of all devices |
| GET | `/ping/:target` | Ping a specific IPv4 address (400 if the target is not a valid IPv4 address; the reserved `0.0.0.0` and `255.255.255.255` are rejected) |
| GET | `/read-config` | Read current configuration |
| POST | `/write-config` | Update and reload configuration |
| GET | `/reload-config` | Reload configuration from disk |
| GET | `/swagger` | Interactive API documentation |
| GET | `/metrics` | Prometheus metrics endpoint |
| GET | `/health` | Health check; 200 while operational, 503 after a fatal net-ping session failure |
| POST | `/restart-service` | Request a graceful service restart (bearer-authenticated; 202 when accepted, 401 without a valid credential, 409 for a duplicate, 503 when disabled) |

## Service Restart

`POST /restart-service` lets an authenticated operator restart the running
process over HTTP. An accepted request returns **202** before the service
starts its existing graceful shutdown (stop the pinger, close the HTTP
server, flush Loki, exit 0); in a Docker deployment the container's
`restart: unless-stopped` policy then starts the process again. A `202`
means *restart requested*, not *service back* — confirm with a subsequent
`GET /health`.

The endpoint is **disabled by default**: it only accepts restarts when the
`RESTART_SERVICE_TOKEN` environment variable holds a strong secret (at
least 32 bytes, e.g. generated with `openssl rand -hex 32`). A present but
shorter or whitespace-only secret fails the service at startup instead of
arming a guessable restart button. The secret is compared in constant time
and never logged; requests without a valid
`Authorization: Bearer <token>` header get `401`, duplicates of an
already-accepted request get `409`, and other verbs get `405`.

```bash
curl -i -X POST http://localhost:32001/restart-service \
  -H "Authorization: Bearer $RESTART_SERVICE_TOKEN"
```

This is a graceful process restart, not a container rebuild: it does not
rebuild the image or apply Compose file edits — for those use
`docker compose up -d --build` (as appropriate) under operator control.
Bearer authentication is not a substitute for transport confidentiality:
keep the endpoint on a trusted management network and terminate TLS at an
authenticated reverse proxy for non-local use. The API's permissive CORS is
unchanged; do not build browser-based cross-origin restart flows on it.

## Prometheus Metrics

### Device Status Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pinged` | Gauge | `ipAddress`, `deviceName`, `deviceType` | 1 if device responds, 0 otherwise |
| `pinged_roundtrip_ms` | Gauge | `ipAddress`, `deviceName`, `deviceType` | Latest round-trip time in milliseconds (updated on successful pings only; keeps the last successful value while the device is down) |
| `pinged_last_success_timestamp` | Gauge | `ipAddress`, `deviceName`, `deviceType` | Unix timestamp of last successful ping |
| `pinged_last_failure_timestamp` | Gauge | `ipAddress`, `deviceName`, `deviceType` | Unix timestamp of last failed ping |

### Latency Distribution

| Metric | Type | Labels | Buckets |
|--------|------|--------|---------|
| `pinged_roundtrip_seconds` | Histogram | `ipAddress`, `deviceName`, `deviceType` | 1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1000ms (+Inf). Records successful pings only — a failed ping produces no latency observation |

### System Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `pinger_cycle_duration_seconds` | Histogram | Duration of complete ping cycles (1s, 5s, 10s, 30s, 60s, 120s, 300s) |
| `pinger_devices_up` | Gauge | Number of devices currently reachable |
| `pinger_devices_down` | Gauge | Number of devices currently unreachable |

### Error Tracking

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pinged_errors_total` | Counter | `ipAddress`, `deviceName`, `deviceType`, `errorType` | Total errors by type |

Error types: `timeout`, `host_unreachable`, `ttl_exceeded`, `other`

### Application Metrics

The state of the service itself, so Prometheus can alert on the pinger the same way it alerts on its devices.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pinger_operational` | Gauge | — | 1 while the pinger can run cycles, 0 after a fatal net-ping session failure (mirrors `/health`) |
| `pinger_last_cycle_timestamp` | Gauge | — | Unix timestamp of the last completed ping cycle |
| `pinger_config_pending_update` | Gauge | — | 1 while a configuration update waits for the ping cycle boundary, 0 otherwise |
| `pinger_config_reload_total` | Counter | `result` | Configuration reload attempts; `result` is `success`, `rejected`, or `rejected_parse` (an unparseable `/write-config` body — 400 malformed / 413 too large) |
| `pinger_config_loaded_timestamp` | Gauge | — | Unix timestamp of when the live configuration was last applied |
| `pinger_config_devices` | Gauge | — | Number of devices in the live configuration |
| `pinger_cycle_delay_seconds` | Histogram | `reason` | Delay of a cycle start beyond its scheduled deadline; `reason` is `interval`, `config_changed`, or `shutdown` |
| `pinger_adhoc_ping_total` | Counter | `result` | On-demand pings via the `/ping` endpoints; `result` is `ok`, `down`, `invalid_target`, or `error` |
| `pinger_loki_send_failures_total` | Counter | — | Failed sends to the Loki transport |
| `pinger_loki_flush_timeouts_total` | Counter | — | Bounded log flushes that timed out before Loki acknowledged |
| `pinger_loki_dropped_entries_total` | Counter | — | Log entries dropped from the Loki pending batch because it exceeded its FIFO cap (the oldest entries are discarded when the in-memory batch is full, which happens while a Loki outage keeps requeuing failed sends) |

The endpoint also serves the standard prom-client `node_*` and `process_*` runtime metrics (uptime, heap, event-loop lag, GC, …).

## Development

All of the following run from the repository's `code/` directory.

```bash
# Run linter
npm run lint

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Watch mode for tests
npm run test:watch
```

## Release History

See [CHANGELOG.md](CHANGELOG.md) for the per-version release history.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Author

Copyright (c) 2026 dodson Software (dodson labs)
