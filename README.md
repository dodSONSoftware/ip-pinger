# IP Pinger Services

Series 4 - IP Pinger Services

**Release:** Cobalt Fox — version 1.11.6.

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
docker run -p 3300:3300 \
  --cap-add=NET_RAW --cap-add=NET_ADMIN \
  -v $(pwd)/src/config.yml:/app/config.yml \
  ip-pinger
```

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

The HTTP API (including `/metrics`) always listens on the fixed port **3300**,
which the Docker deployment and health checks are bound to. It is not a
configuration option.

### Configuration Options

| Option | Description | Default | Valid Values |
|--------|-------------|---------|--------------|
| `logLevel` | Logging verbosity | `info` | `debug`, `info`, `warn`, `error` |
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
- **Restart-required** (active only after a process restart): `logLevel`, `lokiUrl`, `lokiEnabled`

`/write-config` and `/reload-config` report this via a machine-readable
`restartRequired` field in the response.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/about` | Service information, version, and release codename |
| GET | `/ping` | Trigger immediate ping of all devices |
| GET | `/ping/:target` | Ping a specific IP address |
| GET | `/read-config` | Read current configuration |
| POST | `/write-config` | Update and reload configuration |
| GET | `/reload-config` | Reload configuration from disk |
| GET | `/swagger` | Interactive API documentation |
| GET | `/metrics` | Prometheus metrics endpoint |

## Prometheus Metrics

### Device Status Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pinged` | Gauge | `ipAddress`, `deviceName`, `deviceType` | 1 if device responds, 0 otherwise |
| `pinged_roundtrip_ms` | Gauge | `ipAddress`, `deviceName`, `deviceType` | Latest round-trip time in milliseconds |
| `pinged_last_success_timestamp` | Gauge | `ipAddress`, `deviceName`, `deviceType` | Unix timestamp of last successful ping |
| `pinged_last_failure_timestamp` | Gauge | `ipAddress`, `deviceName`, `deviceType` | Unix timestamp of last failed ping |

### Latency Distribution

| Metric | Type | Labels | Buckets |
|--------|------|--------|---------|
| `pinged_roundtrip_seconds` | Histogram | `ipAddress`, `deviceName`, `deviceType` | 1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1000ms (+Inf) |

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

Error types: `timeout`, `host_unreachable`, `network_unreachable`, `ttl_exceeded`, `other`

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
