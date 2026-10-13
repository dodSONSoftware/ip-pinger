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
| KI-008 | API semantics | `/write-config` persistence failures are currently returned as HTTP 400, even when caused by server permissions or I/O. | Treat response body as diagnostic; consider server-side 5xx for I/O errors in a future change. |

## Open verification items

- Test network faults and fatal ICMP session events under the target host/container runtime, not only mocked unit tests.
- Confirm `/metrics` cardinality and memory use with production-sized inventories and frequent configuration changes.
- Review exposure of raw config/host inventories in `/read-config` and console dumps against current network trust boundaries.

No additional reproducible code defects were established solely by this documentation review. Add a minimal reproduction, observed/expected behavior, severity, and verification test for newly confirmed bugs.
