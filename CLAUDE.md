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
│   └── swagger.ts        # Swagger UI setup
├── tests/__tests__/      # Jest test files
├── dist/                 # Compiled output (generated)
├── config.yml            # Runtime configuration (YAML format)
└── package.json          # Dependencies and scripts
```

## Active Project

### IP Pinger Service — Network Device Monitoring

An Express-based service that periodically pings configured devices and exposes Prometheus metrics for monitoring.

**Commands:**
```bash
npm run build   # Compile TypeScript and copy config.yml to dist/
npm start       # Run compiled app: node ./dist/index.js
npm run dev     # Development mode with hot reload: nodemon + ts-node
npm test        # Run Jest tests
npm run lint    # Run ESLint
```

**Architecture:**
- Single Express server on configurable port (default 3300)
- Scheduled ping loop using net-ping library
- Prometheus gauge/histogram metrics for ping status and timing
- YAML configuration with Zod validation
- Hot-reload configuration support

**Key Files:**
- `src/index.ts` — DI bootstrap, config load, middleware setup, route registration
- `src/Pinger.ts` — Core pinger class with net-ping session management
- `src/common.ts` — Configuration loading with Zod schema validation
- `src/config.yml` — Runtime configuration (YAML format)

## Architecture

### Boot Sequence
1. `initialize()` reads `CONFIG_PATH` environment variable
2. Loads `config.yml` into global `configuration` map
3. Creates `Logger` instance with configuration
4. Creates `Pinger` instance with configuration and logger
5. Express servers start on Prometheus/API port
6. Enters infinite loop calling `pinger_dude.run()`

### Pinger Loop (`Pinger.ts`)
```
while (true):
    wait 2 seconds
    for each device in config.devices:
        ping_idevice(device) → Promise<[ip, name, alive, roundtrip]>
    process results:
        set prometheus_Pinger_Up_Gauge[ip, name] = alive ? 1 : 0
        set prometheus_Pinger_Roundtrip_Gauge[ip, name] = roundtrip_ms
    wait for remainder of interval_secs cycle
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

**Note on Memory Management:** The `rebuildPrometheusGauges()` method does NOT call `register.clear()` to avoid memory leaks associated with frequent registry clearing (prom-client#567). Device-specific gauges are replaced by creating new instances; non-device metrics persist across config reloads.

### Configuration (`config.yml`)
```yaml
logLevel: debug
alwaysLogErrors: true
apiPort: 3300
intervalSecs: 60
devices:
  - source: "device-name"
    ipAddress: "192.168.1.100"
    deviceType: sensor|server|kiosk
```

### Hot-Reload Configuration

Configuration can be updated at runtime without restarting the service:

- **GET `/read-config`** — Returns current configuration
- **POST `/write-config`** — Updates configuration from request body and reloads it
- **GET `/reload-config`** — Reloads configuration from disk without changing payload

Note: Configuration is stored in YAML format (`src/config.yml`) instead of JSON.

The `Pinger.updateConfig()` method allows runtime configuration updates via the route handlers.

## Key Patterns

- **Global state via module:** `configuration` Map holds runtime config
- **Error recovery:** Unhandled exceptions logged via `logger.write_error()`, loop continues
- **Net-ping library:** Uses `createSession()` with IPv4, 16-byte packets, 1 retry, 2s timeout, 128 TTL
- **Promise-based pinging:** `pingHost()` wrapped in Promise for async/await compatibility
- **Prometheus gauges:** Separate gauges for up status and round-trip time
- **Zod validation:** Schema-based config validation with readable error messages

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
| GET | `/ping/:target` | Pings specified IP address |
| GET | `/read-config` | Reads current configuration |
| POST | `/write-config` | Updates and reloads configuration |
| GET | `/reload-config` | Reloads configuration from disk |
| GET | `/swagger` | Swagger UI for API documentation |
| GET | `/metrics` | Prometheus metrics endpoint |

## Ports

- **HTTP API (includes metrics)**: Port 3300 (default, configurable via `apiPort`)

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
