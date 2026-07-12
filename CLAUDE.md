# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

An Express-based IP network pinger service written in TypeScript. Periodically pings configured devices and exposes Prometheus metrics for monitoring.

## Running / Deploying

```bash
npm run build   # Compile TypeScript and copy config.yml to dist/
npm start       # Run compiled app: node ./dist/index.js
npm run dev     # Hot-reload dev: nodemon --watch src --exec ts-node src/index.ts
npm test        # Run Jest tests
npm run lint    # Run ESLint
```

## Project Structure

```
src/
├── index.ts              -- Entry point: initialize() → infinite loop calling run()
├── Pinger.ts             -- Core pinger class using net-ping library
├── Logger.ts             -- Logging utility with configurable levels (None, Info, Warn, Error, Debug)
├── common.ts             -- Configuration loading with Zod validation
├── interfaces.ts         -- TypeScript interfaces (IPinger, ILogger, IConfig, IDevice)
├── systemFunctions.ts    -- Utility functions (get_timestamp, sleep, sleep_from_start, ensureError)
├── swagger.ts            -- Swagger UI setup
├── routes/
│   └── generalRoutes.ts  -- Express route handlers
├── config.yml            -- Runtime configuration (YAML format)
└── package.json          -- Dependencies and scripts
```

## Architecture

### Boot Sequence
1. `initialize()` reads `config.yml` into global `configuration` map
2. Creates `Logger` instance with configuration
3. Creates `Pinger` instance with configuration and logger
4. Express servers start on both Prometheus and API ports
5. Enters infinite loop calling `pinger_dude.run()`

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
- `pinged` (Gauge) — 1 if device responds, 0 otherwise. Labels: `ip_address`, `device_name`
- `pinged_roundtrip_ms` (Gauge) — Round-trip time in milliseconds. Labels: `ip_address`, `device_name`

### Configuration (`config.yml`)
```yaml
log-level: debug
always-log-errors: true
prometheus-port: 9090
api-port: 3300
interval-secs: 60
devices:
  - source: "device-name"
    ip-address: "192.168.1.100"
    device-type: sensor|controller|kiosk
```

### Hot-Reload Configuration

Configuration can be updated at runtime without restarting the service:

- **GET `/read-config`** — Returns current configuration
- **POST `/write-config`** — Updates configuration from request body and reloads it
- **GET `/reload-config`** — Reloads configuration from disk without changing payload

Note: Configuration is now stored in YAML format (`config.yml`) instead of JSON.

The `Pinger.updateConfig()` method allows runtime configuration updates via the route handlers.

## Key Patterns

- **Global state via module:** `configuration` Map holds runtime config
- **Error recovery:** Unhandled exceptions logged via `logger.write_error()`, loop continues
- **Net-ping library:** Uses `createSession()` with IPv4, 16-byte packets, 1 retry, 2s timeout, 128 TTL
- **Promise-based pinging:** `pingHost()` wrapped in Promise for async/await compatibility
- **Prometheus gauges:** Separate gauges for up status and round-trip time

## Development

- **Node >= 22 required** (Volta pinned to 22.22.0)
- **TypeScript 5.x** with strict mode enabled
- **Dependencies:** express, cors, body-parser, net-ping, prom-client, zod, swagger-jsdoc, swagger-ui-express, js-yaml
- **Dev dependencies:** @types/* packages, nodemon, ts-node-dev, jest, ts-jest

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/about` | Service information and available commands |
| GET | `/ping` | Pings all configured devices |
| GET | `/ping/:target` | Pings specified IP address |
| GET | `/metrics` | Prometheus scrape endpoint |
| GET | `/read-config` | Reads current configuration |
| POST | `/write-config` | Updates and reloads configuration |
| GET | `/reload-config` | Reloads configuration from disk |

## Ports

- **Prometheus metrics**: Port 9090 (default)
- **HTTP API**: Port 3300 (default, configurable via `api_port`)

## Swagger

- **GET `/swagger`** — Swagger UI for API documentation (auto-generated from JSDoc comments)

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
