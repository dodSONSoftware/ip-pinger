# IP Pinger Services — System Invariants

This document defines guarantees and implementation constraints that must remain true when modifying IP Pinger Services.

1. **Valid startup:** `CONFIG_PATH` must be set and refer to readable, Zod-valid YAML before monitoring begins. Failed validation is not silently replaced by defaults.
2. **Valid devices:** At least one valid IPv4 device exists; each `(ipAddress, source, deviceType)` triple is unique. `deviceType` is one of `sensor`, `server`, or `kiosk`. The reserved addresses `0.0.0.0` and `255.255.255.255` do not count as valid devices.
3. **One active server:** Express listens on fixed port 32001. The HTTP bind must succeed before the scheduler starts.
4. **Startup-owned settings:** Active `logLevel`, `lokiEnabled`, and `lokiUrl` do not silently change on reload. `restartRequired` compares disk changes with the original active baseline.
5. **Atomic cycle view:** An in-flight monitoring cycle finishes using its original device snapshot before a pending configuration is applied. Pending updates cannot allow a stale result to recreate removed device metrics.
6. **Stable metric registry:** Prometheus metric objects and default process metrics are registered once per process; updates remove only obsolete device label series. Do not call global `register.clear()` on configuration reload.
7. **Identity-aligned metrics:** Device series use `ipAddress`, `deviceName`, `deviceType` labels; removals also clear matching error-label variants and stale edge-transition state.
8. **Latency integrity:** Failed and canceled probes do not add successful latency observations. The last successful RTT gauge may remain populated while `pinged=0`.
9. **Cancellation semantics:** Closing the session as part of shutdown does not record canceled probes as device failures, errors, or latency samples.
10. **Operational truth:** An unexpected ICMP session failure makes `isOperational()` false, `/health` 503, and `pinger_operational` 0; the main process exits nonzero rather than permanently advertising health.
11. **Error containment:** Async Express handlers forward failures to error middleware; the API does not leak unhandled rejected promises. Well-formed client error statuses are preserved.
12. **Logging semantics:** Both sinks honor the startup log-level threshold; complete configuration dumps are console-only, and Loki failures cannot indefinitely stall any exit path.
13. **Version consistency:** Keep `code/src/version.ts` (`APP_VERSION`) and `code/package.json` version aligned when making releases. Maintain `CHANGELOG.md` newest first.
14. **Authenticated one-shot restart:** `POST /restart-service` schedules no shutdown without a valid configured bearer secret; the endpoint is disabled (503) when the secret is unset or when no shutdown hook was injected, and a present-but-weak secret fails startup rather than running. An accepted request causes at most one shutdown per process (one 202, duplicates get 409). Only `code/src/index.ts` owns process exit; no route or injected callback signals the process or talks to the Docker daemon — the container's restart policy is the only restart mechanism, and the deployment keeps its non-root runtime (no Docker socket, no added capabilities).

### Regression checks

Run `npm run build`, `npm run lint`, and `npm test`; see [Testing](TESTING.md) for test coverage and high-risk scenarios. Changes to configuration, reload behavior, session failure, or metrics should include focused regression tests.
