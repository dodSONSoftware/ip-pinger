# IP Pinger Services

Series 4 - IP Pinger Services

**Release:** Cobalt Fox — version 1.11.27.

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
- **Graceful shutdown**: SIGINT/SIGTERM cleanly close the HTTP API server and net-ping session before exiting
- **Swagger UI**: Interactive API documentation at `/swagger`
- **Multi-port support**: Combined API and metrics on single port

## Quick Start

### Prerequisites

- Node.js >= 22.22.0 ([Volta](https://volta.sh/) managed)
- npm >= 10.9.4

### Running Locally

```bash
# Install dependencies
npm install

# Build the TypeScript code
npm run build

# Start the service
npm start
```

For development with auto-reload:

```bash
npm run dev
```

### Using Docker

```bash
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

Create or modify `src/config.yml`:

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
| `logLevel` | Logging verbosity (applies to both console and Loki output) | `info` | `debug`, `info`, `warn`, `error` |
| `intervalSecs` | Ping cycle interval | `60` | Positive integer |
| `devices` | Array of devices to ping | required | Array of device objects |

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
`restartRequired` field in the response.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/about` | Service information, version, and release codename |
| GET | `/ping` | Trigger immediate ping of all devices |
| GET | `/ping/:target` | Ping a specific IPv4 address (400 if the target is not a valid IPv4 address) |
| GET | `/read-config` | Read current configuration |
| POST | `/write-config` | Update and reload configuration |
| GET | `/reload-config` | Reload configuration from disk |
| GET | `/swagger` | Interactive API documentation |
| GET | `/metrics` | Prometheus metrics endpoint |
| GET | `/health` | Health check; 200 while operational, 503 after a fatal net-ping session failure |

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

## Development

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

## Recent Changes

| Version | Changes |
|---------|---------|
| v1.11.27 | Harden shutdown and terminal error handling: the main loop breaks once the pinger is closed (re-entering `run()` on a closed pinger spun the event loop and starved the in-flight `close()`), `uncaughtException`/`unhandledRejection` are logged to console + Loki, flushed to Loki with a bounded 3s timeout, then exit non-zero for a container restart, `POST /write-config` answers 500 for unexpected server-side failures (invalid payloads still 400), config-route load failures log at a single point, and `logLevel` now gates Loki output as well as console |
| v1.11.26 | Answer forwarded errors that carry an HTTP status with that status instead of a blanket 500: a malformed JSON body (e.g., to `/write-config`) now returns the body-parser 400 and an oversized payload its 413, and client errors are logged at warn level instead of error |
| v1.11.25 | Align the fixed API port to **32001** everywhere it is referenced: the `API_PORT` constant, the Dockerfile `EXPOSE`/healthcheck, `docker-compose.yml` port mapping and healthcheck, the README/CLAUDE port documentation, the `/about` endpoint description, and the port-related tests |
| v1.11.24 | Make the Docker config mount work with `POST /write-config`: the host config is now a **directory** owned by uid 1000 (mounted at `/app/config`), because atomic temp-file+rename persistence can never replace a single-file bind mount (`EBUSY`) or write into a `root`-owned directory (`EACCES`); `docker-refresh.sh` pre-creates and chowns the config directory before startup and blocks on `docker compose up --wait` until the `/health` check passes |
| v1.11.23 | Apply hot-reloaded configuration at the cycle boundary and wake the run loop on a config change or `close()`: a new `intervalSecs` takes effect without waiting out the old interval, and shutdown stops the loop immediately instead of sleeping out the cycle |
| v1.11.22 | Validate the `/ping/:target` target as an IPv4 address before pinging: invalid targets are rejected with a 400 using the same shared schema as configured device addresses, instead of reaching net-ping |
| v1.11.21 | Stop advertising a deployment-specific server address in the OpenAPI document: the hard-coded `servers` URL is removed so Swagger UI targets the origin serving `/swagger` |
| v1.11.20 | Make the `/about` boot date instance-local: each route registration carries its own boot date instead of mutating a shared module-level value |
| v1.11.19 | Forward async route failures to Express error handling: `/ping`, `/ping/:target`, and `/metrics` failures are answered with a logged 500 JSON response instead of an unhandled rejection |
| v1.11.18 | Treat a net-ping session failure as fatal: `/health` reports 503 and the process exits non-zero for a container-managed restart |
| v1.11.0 | Add graceful shutdown (`Pinger.close()`) and remove unused public surface |
| v1.9.5 | Remove unused port 9090 references |
| v1.9.4 | Add README.md documentation |
| v1.9.3 | Fix 'metric already registered' error on config reload |
| v1.9.2 | Properly remove extra/missing metrics on config change |
| v1.9.1 | Prevent memory leak in rebuildPrometheusGauges() |
| v1.9.0 | Add histogram metrics and additional Prometheus telemetry |

## License

MIT License - See [LICENSE](LICENSE) for details.

## Author

Copyright (c) 2026 dodson Software (dodson labs)
