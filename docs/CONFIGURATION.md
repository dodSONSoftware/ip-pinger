# IP Pinger Services — Configuration

This document specifies configuration settings, defaults, validation, deployment paths, and runtime update semantics for IP Pinger Services.

## Environment and paths

`CONFIG_PATH` is **required** and must point to a readable YAML file at startup. `code/src/common.ts` throws during import if it is unset. The HTTP port is the constant `API_PORT = 32001`, not configurable by YAML or environment. `npm run build` copies `code/src/config.yml` to `code/dist/config.yml`, but **does not set `CONFIG_PATH`**.

Docker Compose sets `CONFIG_PATH=/app/config/config.yml`, publishes 32001, and bind-mounts `/mnt/ip-pinger-data/config:/app/config:rw`. The container runs as UID 1000 and needs directory write access to atomically replace the YAML file. Create the host directory and place `config.yml` there before starting; avoid a single-file bind mount because rename-based writes can fail (`EBUSY`). The image grants the Node executable `CAP_NET_RAW`; Compose also adds `NET_RAW` for ICMP.

## YAML schema

```yaml
logLevel: info
intervalSecs: 30
devices:
  - source: "Router"
    ipAddress: "192.168.1.1"
    deviceType: server
lokiEnabled: false
# lokiUrl: "http://loki.example:3100"
```

| Field | Required | Constraints | Application |
| --- | --- | --- | --- |
| `logLevel` | Yes | `debug`, `info`, `warn`, `error`; no implicit default | Restart |
| `intervalSecs` | Yes | Positive integer seconds, at most `86400` (one day); no implicit default | Live |
| `devices` | Yes | At least one device; identity triple unique | Live |
| `devices[].source` | Yes | String | Live |
| `devices[].ipAddress` | Yes | Valid IPv4 address (the reserved `0.0.0.0` and `255.255.255.255` are rejected) | Live |
| `devices[].deviceType` | Yes | `sensor`, `server`, or `kiosk` | Live |
| `lokiEnabled` | No | Boolean; absent treated as false by logger | Restart |
| `lokiUrl` | Conditional | URL; required if `lokiEnabled: true` | Restart |

A device identity is the triple `(ipAddress, source, deviceType)`. Two entries can share an IPv4 address if source or type differs; exact duplicate triples are rejected. Zod strips unrecognized object keys from the parsed configuration rather than supporting extra settings.

## Runtime configuration API

- `GET /read-config` returns file content, not necessarily the configuration currently applied to the in-flight cycle.
- `POST /write-config` accepts a JSON configuration object, validates it, writes formatted YAML to `CONFIG_PATH`, re-reads it, and requests an update. Invalid payloads return 400; persistence failures (server-side I/O faults on `CONFIG_PATH`) return 500; unexpected processing failures return 500.
- `GET /reload-config` validates the current file and requests an update. Invalid or unreadable file returns 400.
- Successful write/reload responses include `restartRequired: boolean`, evaluated against the **original startup** values of `logLevel`, `lokiUrl`, and `lokiEnabled`. A true value means those settings are stored but not active until restart.
- Live settings apply immediately when idle; updates during a cycle are deferred until the cycle boundary. Validation precedes persistence and application. A reload does not reset unrelated Prometheus series.
- The validate→persist→apply sequence of `/write-config` and `/reload-config` runs under a route-local lock, so two overlapping requests cannot interleave on the shared file: the configuration a response reports as applied is always the configuration on disk.

## Logging

The log level filters console and Loki sinks. Loki operates only when both enabled and a URL is configured. Persistent failures are rate-limited in warning output but separately counted by the `pinger_loki_send_failures_total` counter. Full YAML configuration dumps intentionally remain local-console-only. Do not store credentials or sensitive configuration in logging payloads; API has no authentication.

## Local commands

```bash
cd code
npm ci
npm run build
CONFIG_PATH="$PWD/dist/config.yml" npm start
# development (uses src/config.yml)
CONFIG_PATH="$PWD/src/config.yml" npm run dev
```

The sample `code/src/config.yml` contains environment-specific LAN addresses and should be customized before deployment. See [Testing](TESTING.md) for checks before applying configuration changes.
