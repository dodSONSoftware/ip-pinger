# IP Pinger Services — Endpoint Inventory

Comprehensive API audit, 2026-10-14. Sources: `code/src/routes/generalRoutes.ts` (route registration), `code/src/Pinger.ts` (middleware, server), `code/src/swagger.ts` (Swagger UI), live read-only probes against the running instance on port 32001, and the automated suite under `code/tests/__tests__/`.

The service exposes exactly nine API routes plus the Swagger UI. There are no undocumented routes: the route set registered by `createRoutes()` matches the `/endpoints` catalog, the `/about` command index, the Swagger annotations, and the live probe of `/endpoints` (verified identical). The fixed listener port is 32001 (`code/src/common.ts`, `API_PORT`).

| # | Method | Path | Purpose | Reads state | Modifies state | Side effects |
|---|--------|------|---------|-------------|----------------|--------------|
| 1 | GET | `/about` | Service metadata (about, system, commands) | Runtime operational state | No | None. `system.status` is computed per request from `isOperational()` |
| 2 | GET | `/ping` | Ad-hoc ping of every configured device | Live configuration | No | Sends ICMP to all configured devices; increments `pinger_adhoc_ping_total{result}` per device |
| 3 | GET | `/ping/:target` | Ad-hoc ping of one IPv4 target | — | No | Sends one ICMP echo to the target; 400 for non-IPv4 or reserved (`0.0.0.0`, `255.255.255.255`) targets without pinging; increments `pinger_adhoc_ping_total{result}` |
| 4 | GET | `/read-config` | Serve the configuration as stored on disk | `CONFIG_PATH` file | No | Console-logs the full configuration text (console sink only, not Loki) |
| 5 | POST | `/write-config` | Validate, persist, and apply a new configuration | Request body, `CONFIG_PATH` | **Yes — rewrites the configuration file** | Atomic temp-file + rename write of `CONFIG_PATH`; hot-applies `intervalSecs`/`devices` to the running pinger (removing Prometheus series of dropped devices); updates `pinger_config_loaded_timestamp`, `pinger_config_devices`, `pinger_config_reload_total{result}`; reports `restartRequired` for `logLevel`/`lokiUrl`/`lokiEnabled` (persisted but not active until restart) |
| 6 | GET | `/reload-config` | Re-read `CONFIG_PATH` and apply hot-reloadable settings | `CONFIG_PATH` file | No (file is read-only here) | Same runtime application and metric updates as #5 minus the file write; 400 if the file is missing or invalid |
| 7 | GET | `/metrics` | Prometheus scrape endpoint | Prometheus registry | No | Renders the process-wide registry: per-device `pinged*` series, `pinger_*` application metrics, default Node process metrics |
| 8 | GET | `/health` | Orchestrator liveness/readiness | `isOperational()` | No | 200 `{"status":"healthy",...}` while operational; 503 `{"status":"unhealthy","reason":...}` after a fatal net-ping session failure |
| 9 | GET | `/endpoints` | Static catalog of the nine routes | — | No | None |
| 10 | GET | `/swagger/` (+ `/swagger/*`) | Swagger UI serving the OpenAPI document built from route JSDoc | Route annotations | No | None |

## Implicit HTTP surfaces (not declared routes)

| Surface | Behavior (verified) |
|---------|---------------------|
| Unknown path, any method | **404** with the app's controlled JSON body `{"success":false,"message":"ERROR: <method> <url> not found."}` (terminal middleware; previously Express's default HTML 404 — fixed 2026-10-14, D-001) |
| Registered path with non-matching method (e.g. `POST /health`) | **405** with the app's controlled JSON body and an `Allow` header (`GET, HEAD` for GET routes, `POST` for `/write-config`) (terminal middleware; previously answered 404 HTML — fixed 2026-10-14, D-001) |
| `OPTIONS` preflight (cors middleware) | **204** with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE` |
| Malformed JSON body on any route | body-parser 400 forwarded to the app error middleware → controlled JSON `{"success":false,"message":"ERROR: POST <path> failed: ..."}`; on `/write-config` only, recorded as `pinger_config_reload_total{result="rejected_parse"}` |
| JSON body over 100 kb | body-parser 413 → same controlled JSON path, `rejected_parse` on `/write-config` |
| Async route handler failure | `next(error)` handoff → app error middleware → controlled JSON 500 (4xx statuses carried by the error are preserved) |
| CORS | `Access-Control-Allow-Origin: *` on all API responses (cors middleware, app-wide) |

## Security properties

- **No authentication or TLS on any endpoint** (known limitation KI-001): anyone who can reach port 32001 can read the configuration (including the Loki URL and full device inventory via `/read-config`) and can rewrite monitoring targets via `POST /write-config`.
- `/ping/:target` accepts **any** syntactically valid IPv4 address (no allowlist), so an unauthenticated client can make the service emit ICMP to arbitrary destinations (subject to KI-002 network constraints).
- Responses do not leak stack traces or file paths beyond the error message text of server-side failures (e.g. `Failed to write file "<CONFIG_PATH>": ...` includes the configured path, which is deployment-specific but not a secret).
- ~~`X-Powered-By: Express` was sent on responses (minor framework fingerprint)~~ — fixed 2026-10-14 via `express.disable("x-powered-by")` in the Pinger constructor (see DEFECTS D-003); the running instance still sends it until redeployed.

## State model

The only mutable application state reachable over HTTP is the configuration file at `CONFIG_PATH` (verified for the live instance to be `/mnt/ip-pinger-data/config/config.yml`). Runtime state derived from it (device list, interval, Prometheus series) changes only through `/write-config` or `/reload-config`, both serialized by the per-instance config-sequence lock in `generalRoutes.ts`.
