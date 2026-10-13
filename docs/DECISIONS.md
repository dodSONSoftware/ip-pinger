# IP Pinger Services — Engineering Decisions

This document records design decisions visible in the implementation, their rationale, and consequences. Dates and original decision authors are not known; these are descriptions of implemented behavior, not reconstructed historical meeting records.

## D-001 — Fixed API port (32001)

**Decision:** `code/src/common.ts` defines `API_PORT`; it is not configurable. **Rationale:** Align Docker publishing, container health checks, and service listener. **Consequence:** Deployments needing another external port must change the host mapping or code rather than YAML.

## D-002 — Strict YAML validation and nonempty device list

**Decision:** `CONFIG_PATH` must be supplied; Zod requires `logLevel`, positive integer `intervalSecs`, and one or more valid IPv4 devices. Exact identity duplicates are rejected. The reserved addresses `0.0.0.0` and `255.255.255.255` are rejected as device addresses and `/ping/:target` targets because they are not usable as a destination. **Rationale:** Fail fast instead of monitoring nothing, generating duplicate Prometheus series, or pinging an address that can never respond. **Consequence:** Invalid configuration blocks startup or update.

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

**Decision:** Share severity filtering, but send full config dumps only to console and structured summaries to Loki; bound Loki flush on terminal failures. **Rationale:** Limit remote-log volume and shutdown stalls. **Consequence:** Detailed config dumps are not searchable in Loki; Loki transport errors have dedicated counters.

## D-009 — Internal-network HTTP API

**Decision:** Expose configuration-write routes and CORS without built-in authentication/TLS. **Rationale:** Implementation targets trusted, private-network deployment. **Consequence:** Restrict network access externally; never publish port 32001 unprotected to untrusted networks.
