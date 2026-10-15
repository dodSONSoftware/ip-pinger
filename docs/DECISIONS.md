# IP Pinger Services — Engineering Decisions

This document records design decisions visible in the implementation, their rationale, and consequences. Dates and original decision authors are not known; these are descriptions of implemented behavior, not reconstructed historical meeting records.

## D-001 — Fixed API port (32001)

**Decision:** `code/src/common.ts` defines `API_PORT`; it is not configurable. **Rationale:** Align Docker publishing, container health checks, and service listener. **Consequence:** Deployments needing another external port must change the host mapping or code rather than YAML.

## D-002 — Strict YAML validation and nonempty device list

**Decision:** `CONFIG_PATH` must be supplied; Zod requires `logLevel`, positive integer `intervalSecs` (capped at `MAX_INTERVAL_SECS`, one day), and one or more valid IPv4 devices. Exact identity duplicates are rejected. The reserved addresses `0.0.0.0` and `255.255.255.255` are rejected as device addresses and `/ping/:target` targets because they are not usable as a destination. **Rationale:** Fail fast instead of monitoring nothing, generating duplicate Prometheus series, or pinging an address that can never respond. The `intervalSecs` cap exists because Node clamps a `setTimeout` delay above 2^31-1 ms to 1 ms: an interval whose millisecond form overflows would silently turn the scheduler into a ~1 ms hot loop pinging every device as fast as the network allows, so the bound is enforced at the validation boundary. **Consequence:** Invalid configuration blocks startup or update.

## D-003 — Separate live and startup-owned configuration

**Decision:** `intervalSecs` and `devices` reload at runtime; logger/Loki settings require restart, compared against startup baseline. **Rationale:** Avoid dynamically rebuilding logging transports and filters during active traffic. **Consequence:** API reports `restartRequired`; persisted values may differ from active logging settings until restart.

## D-004 — Apply device changes only at safe cycle boundaries

**Decision:** Defer updates while a ping cycle is in flight, then delete only removed devices' labeled metrics/state. **Rationale:** Prevent late results from republishing removed series; retain historical counters and metric objects for unchanged devices. **Consequence:** A successful update can be pending briefly; registry-wide `clear()` is inappropriate.

## D-005 — ICMP rather than TCP application checks

**Decision:** Use one `net-ping` IPv4 raw-socket session. **Rationale:** Check host ICMP reachability at regular intervals without per-device ports. **Consequence:** `NET_RAW` capability is required; firewalls and ICMP restrictions can yield false device-down results. This does not test application-layer health.

## D-006 — Prometheus exposition and meaningful latency samples

**Decision:** Track status, latency, errors, timestamps, lifecycle, and process metrics; record latency histogram observations only when ping succeeds. **Rationale:** Separate network failure from response time, avoid synthetic zero-latency samples, and support alerts for the monitor itself. **Consequence:** Last successful latency gauge remains unchanged during outages and must be interpreted alongside `pinged`.

## D-007 — Explicit fatal session and shutdown semantics

**Decision:** Treat unexpected session errors/closures as fatal; cancel in-flight pings on shutdown without counting them as network failures. **Rationale:** Avoid false healthy status and distorted failure metrics after the probing socket dies. **Consequence:** `/health` returns 503 and an orchestrator can restart the container; shutdown is guarded against reentry.

## D-008 — Split console and Loki payloads

**Decision:** Share severity filtering, but send full config dumps only to console and structured summaries to Loki; flush the Loki transport with a bounded timeout on every non-crash exit (graceful signal shutdown, fatal ping-engine termination, terminal unhandled errors). **Rationale:** Limit remote-log volume and shutdown stalls; winston-loki holds entries for its 5 s send interval, so an unflushed exit discards the shutdown tail — the bounded wait keeps an unreachable Loki from stalling any exit. The flush must *trigger* the send, not merely wait for it: winston-loki's own `flush()` (waitFlushed) only observes the batch loop's next scheduled tick (5 s default) and never starts one, so the 3 s bound expired before the tick and the tail was still lost on most healthy restarts (KI-010). Since 1.16.12, `Logger.flush()` calls the transport's `close()` — which stops the batch loop and performs an immediate final send — before the bounded wait; that is safe because `flush()` is only invoked from process-exit paths, after which the stopped loop is irrelevant. **Consequence:** Detailed config dumps are not searchable in Loki; Loki transport errors have dedicated counters; a graceful stop can take up to ~3 s longer (within Docker's 10 s grace), and the shutdown lines and the final-cycle tail are queryable in Loki whenever Loki is reachable. When Loki is already down at exit, a fast-refused send still resolves the flush (the entries are requeued and then lost at `process.exit`); that residual loss is documented as KI-011 and is observable via `pinger_loki_send_failures_total`.

## D-009 — Internal-network HTTP API

**Decision:** Expose configuration-write routes and CORS without built-in authentication/TLS. **Rationale:** Implementation targets trusted, private-network deployment. **Consequence:** Restrict network access externally; never publish port 32001 unprotected to untrusted networks.

## D-010 — Distinct `rejected_parse` outcome for unparseable config-write bodies

**Decision:** `pinger_config_reload_total` gains a `rejected_parse` result value, recorded by the shared error middleware when a body-parser entity error (400 malformed / 413 too large) reaches it for `POST /write-config`. **Rationale:** a body that fails JSON parsing never forms a candidate configuration, so it is a distinct class from `rejected` (which covers validation, write, and load failures acting on a parsed config); recording it in the metric, not only the log, lets Prometheus alert on it. **Consequence:** the `result` label set grows by one value; existing `success`/`rejected` series are unaffected.

## D-011 — Bounded in-memory Loki batch (FIFO drop-oldest)

**Decision:** the Loki transport is a `winston-loki` subclass (`BoundedLokiTransport`, `code/src/Logger.ts`) that, after every write, trims the Batcher's pending batch to the newest `MAX_PENDING_LOKI_ENTRIES` (10 000) entries, dropping the globally oldest first across the per-level label streams. **Rationale:** winston-loki keeps the whole unsent batch resident in memory and requeues it in full after every failed send (`clearOnError` defaults to false), and its `timeout` option is inert (never wired to the underlying request), so a prolonged Loki outage lets the batch — and the process RSS — grow without bound; a bounded, recent tail caps memory and ensures the logs that survive a long outage are the most recent ones (the last set of logs, per the intended FIFO semantics). **Consequence:** during a long outage, pending entries older than the 10 000-entry window are dropped to keep memory bounded; the most recent window is retained and delivered on recovery. The cap is a module constant (`MAX_PENDING_LOKI_ENTRIES`), not a configuration option, and only the Loki transport is affected — the console transport is synchronous and unbounded by design.
