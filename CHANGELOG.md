# IP Pinger Services — Changelog

All notable changes to the IP Pinger Services are documented in this file.
Versions are listed newest first.

## [1.15.1] — Ceramic Fox (2026-10-13)

- Make `docker-refresh.sh` recover from a stale `ip-pinger` container left behind by deployments made while the compose file still lived at the repository root: the script now removes such a name-conflicting container just before starting the new one (after the image build, so the old service keeps serving until the new image is ready), instead of failing with a container-name conflict
- Give the compose project an explicit name (`ip-pinger`), since the default directory-based name collided with the sibling sensor-services project and produced orphan-container warnings

## [1.15.0] — Ceramic Fox (2026-10-13)

- No user-visible changes; version bump only

## [1.14.0] — Silicon Fox (2026-10-13)

- Move all application code and tooling into the `code/` directory to match the sibling services' repository layout: source, tests, and the TypeScript/Jest/ESLint build configuration live under `code/`, with the Dockerfile, docker-compose, and refresh script alongside; build, test, and Docker commands now run from `code/` and the repository root holds only documentation and agent files
- Add the reference documentation set under `docs/` (architecture, configuration, engineering decisions, system invariants, known issues, testing), covering the boot sequence, configuration schema and reload semantics, the metrics surface, and the regression matrix

## [1.13.0] — Graphite Fox (2026-10-11)

- Add application-level Prometheus metrics so Prometheus can alert on the pinger the same way it alerts on its devices: `pinger_operational` (1 while the pinger can run cycles, 0 after a fatal net-ping session failure — mirrors `/health`'s 503), `pinger_last_cycle_timestamp` (a stale timestamp is the signal that the run loop has stopped running cycles), `pinger_cycle_delay_seconds` (how far a cycle start lands beyond its scheduled deadline, by the reason the inter-cycle wait ended), `pinger_config_pending_update` (1 while a configuration update waits for the cycle boundary), `pinger_config_reload_total` (reload attempts by `result` — `success`/`rejected`, where `rejected` covers validation, file-write, and load failures), `pinger_config_loaded_timestamp` and `pinger_config_devices` (when the live configuration was last applied and how many devices it holds), and `pinger_adhoc_ping_total` (on-demand pings via the `/ping` endpoints by `result` — `ok`/`down`/`invalid_target`/`error`)
- Make the Loki transport's health visible in `/metrics`: `pinger_loki_send_failures_total` counts every failed batched send (the warn is rate-limited to one per five minutes, the counter is not) and `pinger_loki_flush_timeouts_total` counts bounded `flush()` calls that timed out before Loki acknowledged the queued entries
- Register the standard prom-client `node_*`/`process_*` process metrics (uptime, heap, event-loop lag, GC, …) on the same `/metrics` endpoint, and extend the `/about` description and the `/metrics` documentation to cover the application- and process-level metrics
- Add regression tests pinning every new metric: the Pinger's application-level metrics, the Logger's Loki counters, and the config- and ping-route handlers' result recording

## [1.12.0] — Carbon Fox (2026-10-11)

- Add edge-triggered device transition logging: a per-device-key alive-state map logs exactly one line at each state change (error `went down`, info `is back up` carrying the roundtrip) — the first observation baselines silently, the entry is removed with the device's metrics on config reload so a re-added device baselines fresh, and the per-cycle per-ping failure error is unchanged; regression tests pin both the baseline/transition behavior and the re-add baselining
- Make the Loki transport self-reporting: its state is logged once at startup (active with URL, or disabled with the reason), winston-loki's `onConnectionError` hook now warns on send failures — the first immediately, then at most one per five minutes while the failure continues, carrying the suppressed count — and `flush()` warns when its bounded wait times out because the queued entries may never have been delivered
- Log one line per configured device at construction so each is individually searchable in the log store from boot time
- Reject an empty `devices` list at validation time (`z.array(...).min(1)`): the configuration must contain at least one device at startup and at `/write-config`/`/reload-config`, so the running service can never be reduced to zero monitored devices
- Add a shutdown re-entrancy guard: a second signal arriving while a shutdown is already in progress is logged at warn and ignored, so a duplicate `close()`/`exit()` pair can never interleave
- Make config-route outcomes visible in the log: `POST /write-config` logs the validation errors (warn) when a payload is rejected with 400, and `/write-config`/`/reload-config` log at info which specific restart-required settings are active only after a process restart when `restartRequired` is true
- Introduce CHANGELOG.md for the per-version release history (the README's Recent Changes table now links to it) and document the logging behavior in the README

## [1.11.40] — Cobalt Fox (2026-10-11)

- Remove dead code from `systemFunctions`: `get_timestamp` no longer takes the `include_ms` parameter (every caller passed `false`, so the milliseconds branch was unreachable) and `read_file` drops a redundant `.toString()` on the already-decoded string

## [1.11.39] — Cobalt Fox (2026-10-11)

- Fix the typos in the `/about` description text ("round- trip" → "round-trip", "monitoring - cycle duration" → "monitoring cycle duration", "network errors.These" → "network errors. These")

## [1.11.38] — Cobalt Fox (2026-10-11)

- Align the Swagger response schemas with the actual payloads: `/ping` now documents the per-device results array (previously an `about`/`version` object the endpoint never returns), `/read-config` documents the parsed configuration object, and `/ping/{target}` uses the real `roundTripMs` field name (the docs said `roundtripMs`); regression tests pin the documented shapes

## [1.11.37] — Cobalt Fox (2026-10-11)

- Align the configuration-options table with the Zod schema: `logLevel` and `intervalSecs` are required (the documented defaults of `info` and `60` never existed — omitting either fails validation at startup or at `/write-config`/`/reload-config`), and `lokiUrl`/`lokiEnabled` are now listed with their actual optionality; regression tests pin the required-field contract

## [1.11.36] — Cobalt Fox (2026-10-11)

- Make `/about` report the live operational state: the `system.status` field is now computed from `isOperational()` at request time instead of serving the static `"healthy"` baseline, so `/about` no longer claims "healthy" while `/health` is already answering 503 after a fatal net-ping session failure; the fatal-session test now asserts both endpoints agree before and after the failure

## [1.11.35] — Cobalt Fox (2026-10-11)

- Make the net-ping module surface compile-checked: the ambient declaration in `src/types/net-ping.d.ts` now mirrors the 1.2.4 exports — adding the seven ICMP error classes (`RequestTimedOutError`, `DestinationUnreachableError`, `TimeExceededError`, `PacketTooBigError`, `ParameterProblemError`, `RedirectReceivedError`, `SourceQuenchError`) and dropping a `default` export the runtime module does not have — and `Pinger.ts` consumes the library through `import netPing = require("net-ping")`, so `createSession`, `NetworkProtocol`, and the `instanceof` operands in `getErrorType` are typed instead of `any`

## [1.11.34] — Cobalt Fox (2026-10-11)

- Treat an unexpected net-ping session close as fatal: a `"close"` event that the application did not initiate (an OS-level socket death with no preceding `"error"` event) now records a synthetic fatal error, so the run loop terminates, `/health` reports 503, and the orchestrator restarts the process — instead of the run loop hanging on a socket that can never send while `/health` still reports healthy. App-initiated closes (graceful `close()` and the fatal-`"error"` close) remain non-fatal, and regression tests pin both directions

## [1.11.33] — Cobalt Fox (2026-10-10)

- Keep the module logger alive from boot: it is seeded with the console-only bootstrap logger so a SIGINT/SIGTERM in the pre-configuration window logs and exits 0 instead of throwing a TypeError that the terminal boundary would report as a non-zero crash, and the terminal boundary flushes Loki only when the full Logger is in place

## [1.11.32] — Cobalt Fox (2026-10-10)

- Remove dead code: the write-only configuration string in the route closure (the raw text lives on the Pinger), the unused `_418`/`Text` route constants, and the unused `systemFunctions` exports (`sleep`, `sleep_from_start`, `randomInt`, `elapsed_time_seconds`, `get_timestamp_iso`, `convert_from_log_level_string_to_enum` — the last also carried a stale TODO)

## [1.11.31] — Cobalt Fox (2026-10-10)

- Correct the ambient `net-ping` type declaration: `NetworkProtocol` now carries the library actual values (IPv4 = 1, IPv6 = 2) instead of 0/1, so a future value import of the enum cannot silently select the wrong address family

## [1.11.30] — Cobalt Fox (2026-10-10)

- Align the documented `pinged_errors_total` taxonomy with the implementation: the error types are `timeout`, `host_unreachable`, `ttl_exceeded`, and `other` (there is no `network_unreachable` — net-ping cannot distinguish host- from network-unreachable), and the stale comment in the stale-series test that described gauge rebuilding now describes the process-lived metrics it actually exercises

## [1.11.29] — Cobalt Fox (2026-10-10)

- Make the `write_file` temporary filename unique per call (`<target>.<pid>.<n>.tmp`): with a fixed `<target>.tmp` name, a second writer against the same mount could overwrite the temp file before the first writer's rename, persisting the second writer's content as the first caller's successful write

## [1.11.28] — Cobalt Fox (2026-10-10)

- Give each Jest worker its own config file: `CONFIG_PATH` in the test setup is now per-worker (`/tmp/test-config-<pid>.yml`), so the suites that seed the config file and read it back through the API can no longer clobber each other under parallel Jest workers

## [1.11.27] — Cobalt Fox (2026-10-10)

- Harden shutdown and terminal error handling: the main loop breaks once the pinger is closed (re-entering `run()` on a closed pinger spun the event loop and starved the in-flight `close()`), `uncaughtException`/`unhandledRejection` are logged to console + Loki, flushed to Loki with a bounded 3s timeout, then exit non-zero for a container restart, `POST /write-config` answers 500 for unexpected server-side failures (invalid payloads still 400), config-route load failures log at a single point, and `logLevel` now gates Loki output as well as console

## [1.11.26] — Cobalt Fox (2026-10-10)

- Answer forwarded errors that carry an HTTP status with that status instead of a blanket 500: a malformed JSON body (e.g., to `/write-config`) now returns the body-parser 400 and an oversized payload its 413, and client errors are logged at warn level instead of error

## [1.11.25] — Cobalt Fox (2026-10-09)

- Align the fixed API port to **32001** everywhere it is referenced: the `API_PORT` constant, the Dockerfile `EXPOSE`/healthcheck, `docker-compose.yml` port mapping and healthcheck, the README/CLAUDE port documentation, the `/about` endpoint description, and the port-related tests

## [1.11.24] — Cobalt Fox (2026-10-08)

- Make the Docker config mount work with `POST /write-config`: the host config is now a **directory** owned by uid 1000 (mounted at `/app/config`), because atomic temp-file+rename persistence can never replace a single-file bind mount (`EBUSY`) or write into a `root`-owned directory (`EACCES`); `docker-refresh.sh` pre-creates and chowns the config directory before startup and blocks on `docker compose up --wait` until the `/health` check passes

## [1.11.23] — Cobalt Fox (2026-10-07)

- Apply hot-reloaded configuration at the cycle boundary and wake the run loop on a config change or `close()`: a new `intervalSecs` takes effect without waiting out the old interval, and shutdown stops the loop immediately instead of sleeping out the cycle

## [1.11.22] — Cobalt Fox (2026-10-07)

- Validate the `/ping/:target` target as an IPv4 address before pinging: invalid targets are rejected with a 400 using the same shared schema as configured device addresses, instead of reaching net-ping

## [1.11.21] — Cobalt Fox (2026-10-07)

- Stop advertising a deployment-specific server address in the OpenAPI document: the hard-coded `servers` URL is removed so Swagger UI targets the origin serving `/swagger`

## [1.11.20] — Cobalt Fox (2026-10-06)

- Make the `/about` boot date instance-local: each route registration carries its own boot date instead of mutating a shared module-level value

## [1.11.19] — Cobalt Fox (2026-10-06)

- Forward async route failures to Express error handling: `/ping`, `/ping/:target`, and `/metrics` failures are answered with a logged 500 JSON response instead of an unhandled rejection

## [1.11.18] — Cobalt Fox (2026-10-06)

- Treat a net-ping session failure as fatal: `/health` reports 503 and the process exits non-zero for a container-managed restart

## [1.11.0] — Cobalt Fox (2026-10-06)

- Add graceful shutdown (`Pinger.close()`) and remove unused public surface

## [1.9.5] (2026-07-14)

- Remove unused port 9090 references

## [1.9.4] (2026-07-13)

- Add README.md documentation

## [1.9.3] (2026-07-13)

- Fix 'metric already registered' error on config reload

## [1.9.2] (2026-07-13)

- Properly remove extra/missing metrics on config change

## [1.9.1] (2026-07-13)

- Prevent memory leak in rebuildPrometheusGauges()

## [1.9.0] (2026-07-13)

- Add histogram metrics and additional Prometheus telemetry

## Unversioned Commits

The following commits predate the version-tagged release history and were never
assigned a version:

- **2026-07-11** — Merge branch 'dev'
- **2026-01-04** — updated Dockerfile and fixed route /restart
- **2026-01-01** — added ping/{ip-address} route
- **2026-01-01** — Merge branch 'dev'
- **2026-01-01** — Added the (ping) web service command
- **2025-12-26** — Merge branch 'main' of http://192.168.1.5:30008/sensor-services/ip-pinger-1
- **2025-12-26** — cleaned up code. started new sensor configuration
- **2025-12-26** — cleaned up code. started new sensor configuration
- **2025-12-16** — fixed ambiguous characters
- **2025-12-16** — added webservice functions
- **2025-12-14** — initial commit
