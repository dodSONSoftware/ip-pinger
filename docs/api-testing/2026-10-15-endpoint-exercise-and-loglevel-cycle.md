# IP Pinger Services — Full Endpoint Exercise and logLevel Restart Cycle

Run date: 2026-10-15, ~05:37–05:45 UTC. Target: the live Docker instance (container `ip-pinger`, image `ip-pinger-ip-pinger:latest`, app v1.16.10 "Quartz Fox") on `127.0.0.1:32001`, config `/mnt/ip-pinger-data/config/config.yml` (16 devices, `intervalSecs: 30`, Loki enabled at `http://10.10.10.60:3100`).

This run intentionally exercised the **mutating** endpoint (`POST /write-config`) and performed **two service restarts**, as explicitly requested: a full endpoint exercise, then a `logLevel` info→(restart)→debug→(restart) cycle to prove the level change takes effect only on restart and gates all log output. The configuration was backed up before the first write (`sha256 952d9f42…3cc7a`) and is byte-identical to it afterwards.

## 1. Endpoint exercise — happy path

All nine cataloged routes plus the Swagger UI were exercised against the live instance.

| # | Endpoint | Result | Verified |
|---|----------|--------|----------|
| 1 | `GET /about` | 200 | `about` = IP Pinger Services 1.16.10 "Quartz Fox"; `system.status` = "healthy"; command index lists 9 commands |
| 2 | `GET /endpoints` | 200 | 9 routes cataloged, matching the registered set |
| 3 | `GET /health` | 200 | `{"status":"healthy","timestamp":…}` |
| 4 | `GET /read-config` | 200 | Top-level config object: `logLevel=debug`, `intervalSecs=30`, 16 devices, `lokiEnabled=true` — matched the file on disk |
| 5 | `GET /ping` | 200 | 16 results; 14 alive (0–30 ms), 2 down: `10.10.10.10`, `10.10.10.171` (host_unreachable) |
| 6 | `GET /ping/10.10.10.2` | 200 | `{"ipAddress":"10.10.10.2","isAlive":true,"roundTripMs":1}` |
| 7 | `GET /reload-config` | 200 | `{success:true, restartRequired:false, message:"Configuration reloaded successfully."}` |
| 8 | `GET /metrics` | 200 | `pinger_config_devices 16`, `pinger_config_loaded_timestamp`, 200 `pinged_*` per-device series, `pinger_adhoc_ping_total{result="ok"} 15 / {result="down"} 2` after the two ad-hoc pings above |
| 9 | `GET /endpoints` / `GET /swagger/` | 200 / 200 | Swagger UI served as `text/html` |

## 2. Error paths and implicit surfaces

| Case | Result | Evidence |
|------|--------|----------|
| `GET /ping/0.0.0.0` | 400 | `{"success":false,"message":"ERROR: '0.0.0.0' is not a valid IPv4 address."}` — no ping sent |
| `GET /ping/255.255.255.255` | 400 | same controlled JSON (reserved broadcast rejected) |
| `GET /ping/999.1.1.1` | 400 | same (octet out of range) |
| `GET /ping/notanip` | 400 | same |
| `GET /ping/0x1.0.0.1` | 400 | same (hex not accepted) |
| `GET /definitely-not-a-route` | 404 | controlled JSON `{"success":false,"message":"ERROR: GET … not found."}` (D-001 fix live in 1.16.10) |
| `POST /health` | 405 | controlled JSON naming allowed methods: `Allowed: GET, HEAD.` (D-001 fix live) |
| `POST /write-config` with malformed JSON | 400 | `ERROR: POST /write-config failed: Expected property name or '}' in JSON at position 1 (line 1 column 2)` |
| `OPTIONS /health` | 204 | `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE` |
| `X-Powered-By` header | **absent** | 1.16.10 `express.disable("x-powered-by")` (D-003) confirmed on the running instance — the ENDPOINT_INVENTORY note "still sent until redeployed" is now stale and was updated |

## 3. logLevel restart cycle

Log line format: `[timestamp][elapsed][LEVEL][originator] message` (Winston console transport; Loki transport inherits the same level gate).

| Step | Time (UTC) | Action | Evidence |
|------|-----------|--------|----------|
| 0 | 05:37 | Baseline | Disk and runtime `logLevel: debug`; DEBUG lines flowing (19 in a 12 s window): `PINGING STARTED`, per-device `"…" Device Alive, Nms.`, `PINGING COMPLETE. 14 up, 2 down`, `Cycle duration`, request log `GET /health` |
| 1 | 05:39:25 | `POST /write-config` with the current config and **only** `logLevel` changed to `info` | Response `{"success":true,"restartRequired":true,"message":"Configuration saved. Restart required for some changes to take effect."}`. Disk diff vs. backup: exactly one line (`logLevel: debug` → `info`) |
| 2 | 05:39:58 | Pre-restart check on the still-running instance | **19 DEBUG lines in a 12 s window** — the in-memory logger still runs at debug; the new level is persisted but inactive, per the documented "persisted, not active until restart" contract |
| 3 | 05:40:30 | `docker restart ip-pinger` | Graceful shutdown line `[INFO][Pinger.close] Pinger closed.`, then INFO boot sequence (`Loki transport active`, `Configuration loaded`, `Ping Interval Cycle: 30 seconds`, `API Server is running at http://localhost:32001`); healthy in ~6 s (healthcheck + `/health` 200) |
| 4 | 05:41:00–05:42:15 | **Observation window at `info`** — 3 complete 30 s ping cycles (05:41:06, 05:41:36, 05:42:06) | **0 DEBUG lines** in 6 total lines. All 6 are `[ERROR] … Device Error (host_unreachable)` for the two down devices (`10.10.10.10`, `10.10.10.171`) — errors pass at any level, which also proves the logger is alive and filtering rather than dead. Zero INFO lines in steady state is by design: every per-cycle, per-device, and per-request line is debug-level; INFO appears on boot and state transitions |
| 5 | 05:42:48 | `POST /write-config` with `logLevel` changed back to `debug` | Same success/`restartRequired:true` response; disk now **byte-identical to the pre-run backup** (sha256 match) |
| 6 | 05:42:48 | `docker restart ip-pinger` | Same graceful close + INFO boot; healthy in ~6 s |
| 7 | 05:43:1x–05:44:3x | **Observation window at `debug`** — 3 cycles | **58 DEBUG lines** returned (`PINGING STARTED/COMPLETE`, all 14 alive devices with RTT, `Cycle duration`, request logging) plus the same 6 ERROR lines from the down devices |

Conclusion: `logLevel` is persisted by `/write-config` without effect, takes effect exactly at the next process start, gates both the console and (by construction) the Loki transport, and preserves error visibility at the reduced level.

## 4. Final state (05:45:30 UTC)

- Container `ip-pinger` up and healthy; `/health` 200; app v1.16.10.
- `logLevel: debug` on disk and per `/read-config`; config sha256 identical to the pre-run backup; 16 devices unchanged; Loki settings unchanged.
- `pinger_config_loaded_timestamp` = `process_start_time_seconds` = 1792042970 (05:42:50Z) — the running registry belongs to the post-cycle boot.
- Note: `pinger_config_reload_total` and `pinger_adhoc_ping_total` show only `# HELP`/`# TYPE` after the restarts — the in-memory Prometheus registry resets on process restart, and no reloads or ad-hoc pings occurred since the final boot. (The pre-first-restart values were `reload success 1`, `adhoc ok 15 / down 2`.)

## 5. Observations

- **No defects found.** All nine endpoints, the five invalid-`/ping/:target` variants, the 404/405/400 controlled-JSON contract, OPTIONS/CORS, and the log-level restart semantics behaved exactly per contract (see ENDPOINT_INVENTORY.md). The full `docker logs` window 05:37–05:52 UTC was reviewed against this run's timeline and matches it exactly (probe bursts, both graceful SIGTERM closes with exit 0, both boot dumps showing the freshly persisted `logLevel`). Two visually odd log behaviors turned out to be documented design (below); one new data point came from the logs (Air-Light-2 latency spikes).
- **Config dumps use a console-only "local" log (by design).** The full configuration dumps at boot and on `/read-config`, `/reload-config`, and `/write-config` are emitted via `Logger.write_local_log()` (`code/src/Logger.ts:285`), which writes straight to stdout/stderr — never through Winston, so they **do not reach Loki** (the split-sink comments at `generalRoutes.ts` and `index.ts` state this intent: keep large config dumps, including the Loki URL, out of the log store). That is why they carry a different header format (`[YYYY-MM-DD HH:MM:SS][elapsed][Info]`) than the app-logger lines (`[ISO-8601 Z][elapsed][INFO ]`). Note the local-log lines bypass the configured `logLevel` entirely — they always emit.
- **Config updates wake the ping cycle (by design).** Every successful `/write-config`/`/reload-config` that lands while no cycle is in flight applies immediately and calls `signalCycleWake()` (`Pinger.ts:469`), so a new cycle starts at the same millisecond and the 30 s schedule re-anchors. Log evidence: cycle starts at 05:37:48.906 (my `/reload-config`) and 05:39:25.473 (my `logLevel: info` write), and the phase shifts :18/:48 → :25/:55 → post-restart :22/:52. Even a restart-required-only change (logLevel) triggers one immediate re-ping of all devices — harmless here (device set unchanged), but worth knowing: a no-op config write costs one ping cycle.
- **First cycle runs ~2 s after boot** — the settle wait `waitForNextCycle(2000)` (`Pinger.run`); observed as PINGING STARTED at 05:42:52.387, ~2.0 s after the 05:42:50.37 boot.
- **Latency spikes, Air-Light-2 (10.10.10.189):** one-off 2013 ms (05:49:54) and 2118 ms (05:51:24) round trips; every other sample in the window was under 100 ms. Transient, no repeating pattern, no service-side action needed — worth a glance at that device if it recurs.
- Two devices have been down for the entire run and in the pre-existing baseline: `10.10.10.10` (Air-Light-3) and `10.10.10.171` (Air-5), `host_unreachable` from source `10.10.10.50`. They are the only ERROR noise and the reason `GET /ping` reports 14 up / 2 down.
- Each `docker restart` took ~6 s to reach healthy (graceful SIGTERM close observed in both cases). Total monitoring gap across the run: ~12 s in two intervals.
- With `logLevel: info`, the Loki write rate drops to error entries only in steady state — the documented level-gating of the Loki transport held.
- Environment note: an unrelated `node dist/index.js` process (PID 1728, running since Oct 14) belongs to the `sensor-services` container, not ip-pinger; it has no bearing on this run.

## 6. Loki verification (queried 2026-10-15, stream `{app="ip-pinger"}`, window 05:36–05:56 UTC)

922 entries retrieved from `http://10.10.10.60:3100` (level counts: 787 debug / 48 info / 86 error / 1 warn; single stream, labels `{app="ip-pinger", env="production"}` with Loki-side extracted `level`/`detected_level`).

| Check | Result |
|-------|--------|
| Split sink: console-only lines stay out of Loki — full config dumps (`Configuration reloaded:/read:/loaded:`), `Booting ip-pinger`, `logLevel:`, `ipAddress:`, `deviceType:`, `lokiUrl:` | **PASS** — 0 hits for all 8 probes; the config (including the Loki URL) never reaches the log store |
| Level gate on the Loki transport during the `info` phase (05:40:31–05:42:48) | **PASS** — 0 debug entries; exactly the 10 expected error entries (2 down devices × 5 cycles). All 787 debug entries sit in the two debug-level process lifetimes |
| Lifecycle lines present — `Loki transport active` ×2, `Pinger class initialized` ×2, `Configured device:` ×32, `API Server is running` ×2, `IP Pinger Application initialized` ×2, `Configuration updated.` ×2 (reload + first write), malformed-JSON WARN ×1 | **PASS** — all present |
| Entry format | **PASS** — 100% JSON payloads (Winston `format.json`); no plain-text lines |
| Timestamp fidelity | **PASS** — Loki ingest ts vs line ts skew: p95 0.000 s, max 0.001 s across all 922 entries |
| Transport health | **PASS** — `pinger_loki_send_failures_total 0`, `pinger_loki_flush_timeouts_total 0`; no connection-error warns in the window |
| Per-cycle shape (14 alive + 2 error per debug-level cycle) | **PASS** — holds for every debug-level cycle; all deviations reconciled (ad-hoc `/ping` probe lines, one window-boundary cycle at 05:36:00.4, and info-phase cycles, which emit no cycle markers at info level) |
| **Shutdown tail** | **GAP (see below)** — the last batch of each process's lifetime is missing |

### Finding: the last ≤5 s of log lines are lost on every graceful restart

Both graceful SIGTERM shutdowns lost their final in-flight batch to Loki:

- **Process 1** (SIGTERM 05:40:30.356): last line in Loki is 05:40:25.506; **8 lines lost** — `GET /health` (05:40:27.371), the cycle's 2 device ERRORs + `PINGING COMPLETE` + `Cycle duration` (05:40:28.525–.526), `Received SIGTERM, shutting down.`, `net_pinger closed.`, `Pinger closed.`
- **Process 2** (SIGTERM 05:42:49.456): last line before the boot is 05:42:36.013; **4 lines lost** — `Restart required for: logLevel` + `Configuration updated.` (05:42:48.525, the second `/write-config`), `Received SIGTERM, shutting down.`, `Pinger closed.`

Root cause (verified in code): winston-loki batches entries and holds them for its **5 s default send interval** (noted in `index.ts:168`), and the graceful `shutdown()` path (`index.ts:89`) goes `close()` → `process.exit(0)` **without calling `logger.flush()`** — only the terminal-error path flushes (`index.ts:194`, bounded by `LOKI_FLUSH_TIMEOUT_MS = 3000`). So on a graceful exit, whatever is still in the batch window — which always includes the shutdown lines themselves, since they are logged microseconds before exit — is discarded. Console logs are unaffected (the console transport writes synchronously), which is why `docker logs` shows what Loki does not.

This is consistent with the DECISIONS.md tradeoff (bound the Loki flush **on terminal failures**, to limit shutdown stalls), but the graceful-shutdown consequence is not documented in KNOWN_ISSUES.md. Practical impact: after each graceful restart, Loki is missing the shutdown lines and the tail of the final partial cycle (including any `went down`/`is back up` INFO transition that occurs in the last 5 s). Options: (a) document it as a known issue, or (b) add `await logger.flush(LOKI_FLUSH_TIMEOUT_MS)` to `shutdown()`'s `finally` before `process.exit(0)` — bounded (+≤3 s shutdown; container stop timeout is 10 s) and mirrors the terminal path.

**Fixed in 1.16.11 (2026-10-15):** option (b) was taken — both non-crash exit paths now flush the Loki transport before exiting; recorded as KI-009 (resolved) in KNOWN_ISSUES.md.

Raw artifacts: response bodies, header dumps, both 75 s log windows, the 922-entry Loki dump (`loki-entries.json`), and the check output are preserved in `/tmp/pinger-report/` on the dev host (not committed).
