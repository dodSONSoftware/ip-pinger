# IP Pinger Services — Known Issues

This document tracks verified limitations and operational risks in the current implementation. Items below are not necessarily open defects; reproduce and test before assigning a bug fix.

| ID | Status | Limitation / impact | Mitigation |
| --- | --- | --- | --- |
| KI-001 | Known limitation | API has no authentication or TLS; anyone able to reach `/write-config` can modify monitored targets. | Restrict port 32001 to a trusted LAN/segment or add authenticated reverse-proxy controls. |
| KI-002 | Known limitation | `net-ping` requires raw socket privileges and IPv4; ICMP-blocked but otherwise healthy hosts show as down. | Grant `NET_RAW`; verify ICMP/firewall rules. Use other health checks for application availability. |
| KI-003 | Deployment constraint | Atomic config replacement cannot safely target a single-file bind mount; root-owned host directory may deny UID 1000 writes (`EBUSY` / `EACCES`). | Mount a writable directory containing `config.yml`, owned/writable by UID 1000. |
| KI-004 | Design constraint | Logging/Loki changes via config API are persisted but not active until process restart. | Inspect `restartRequired`, then restart intentionally. |
| KI-005 | Observability caveat | `pinged_roundtrip_ms` retains last successful reading while device is down; the timestamp and `pinged` status must be consulted. | Gate latency dashboards/alerts on `pinged == 1`. |
| KI-006 | Known limitation | No automatic device discovery; inventory is managed manually through YAML/API. | Maintain a curated `devices` array. |
| KI-007 | Deployment caveat | `npm start` does not set `CONFIG_PATH`, and the Docker image does not bundle the runtime bind-mounted config path. | Export `CONFIG_PATH`; provision and mount config before launching. |
| KI-008 | Resolved (2026-10-14) | `/write-config` persistence failures were returned as HTTP 400, even when caused by server permissions or I/O. | Fixed: the write-failure branch now answers 500 (the payload has already validated, so any `write_file` failure is a server-side filesystem fault); the response body remains diagnostic and the outcome still records `pinger_config_reload_total{result="rejected"}`. |
| KI-009 | Resolved (2026-10-15) | The last ≤5 s of log entries — always including the shutdown lines — were lost from Loki on every graceful restart: the non-crash exit paths ran `process.exit` without flushing winston-loki's 5 s batch window, while the console record (synchronous transport) stayed complete. | Fixed in 1.16.11: the graceful signal shutdown and the fatal ping-engine termination now flush the Loki transport with a bounded 3 s timeout before exiting, mirroring the terminal error boundary; the flush-timeout warn and `pinger_loki_flush_timeouts_total` remain the observability surface if Loki is unreachable at exit. |

## Open verification items

- Test network faults and fatal ICMP session events under the target host/container runtime, not only mocked unit tests.
- Confirm `/metrics` cardinality and memory use with production-sized inventories and frequent configuration changes.
- Review exposure of raw config/host inventories in `/read-config` and console dumps against current network trust boundaries.

No additional reproducible code defects were established solely by this documentation review. Add a minimal reproduction, observed/expected behavior, severity, and verification test for newly confirmed bugs.
