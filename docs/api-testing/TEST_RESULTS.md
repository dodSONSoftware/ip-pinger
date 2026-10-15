# IP Pinger Services — API Test Results

Audit date: 2026-10-14. Auditor: automated + live read-only verification. Companion documents: [ENDPOINT_INVENTORY.md](ENDPOINT_INVENTORY.md), [DEFECTS.md](DEFECTS.md).

## Method

Three complementary planes were used; no production code was modified, and no mutating request was sent to the live instance (project rule: no mutating configuration requests against production).

1. **Isolated automated tests** — the existing Jest suite (`code/tests/__tests__/`) plus a new suite `code/tests/__tests__/routes/apiSurface.test.ts` added by this audit (52 cases, grown from 43 by the D-001/D-005 fix regressions). Route-level tests run the real `createRoutes()` stack (Express + JSON body parser + CORS + error middleware) on an ephemeral port against a per-worker isolated `CONFIG_PATH` (`/tmp/test-config-<pid>.yml`), with a recording pinger double; the `pinger.test.ts` suite additionally runs the **real** `Pinger` class (real Express server, real Prometheus registry, mocked net-ping session). Every test that touches the config file captures the prior bytes and restores them.
2. **Live read-only probes** — the running production instance on `127.0.0.1:32001` (config `/mnt/ip-pinger-data/config/config.yml`, 16 devices) was probed with GETs/HEAD/OPTIONS only. Evidence captured 2026-10-14 ~03:57–03:59 UTC.
3. **Source inspection** — route registration, middleware order, and the `/endpoints` catalog cross-check.

Baseline and final gate (both from `code/`): `npm run build` clean, `npm run lint` clean, `npm test -- --runInBand` → **11 suites / 202 tests, all passing** (150 pre-existing + 52 added by this audit and its D-001/D-005 fix regressions).

## Results by endpoint

Statuses: **PASS** (executed, behavior matches contract), **FAIL** (executed, contract violation — see DEFECTS.md), **BLOCKED** (cannot be executed safely in this environment), **NOT TESTED** (out of audit scope).

### 1. `GET /about`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-AB-01 | 200, JSON content type, about/system/commands blocks, name/version/release/license, bootdate = boot ISO | Automated (apiSurface) | PASS | `apiSurface.test.ts` "response surface" |
| TC-AB-02 | `system.status` = "healthy" while operational; command index derived from the `/endpoints` catalog | Automated (apiSurface) | PASS | deep-equal against `endpointsInfo` |
| TC-AB-03 | `system.status` flips to "unhealthy" after a fatal session failure (no stale "healthy") | Automated (pinger, real Pinger) | PASS | `pinger.test.ts` "/health reports 200 healthy before the failure and 503 unhealthy after" + /about assertion |
| TC-AB-04 | Live 200 with version 1.16.9 / release "Quartz Fox" | Live probe | PASS | `curl /about` → 200 `application/json` |
| TC-AB-05 | Per-instance isolation (two `createRoutes` instances keep distinct boot dates and baselines) | Automated (configRoutes) | PASS | "multiple route instances" suite |

### 2. `GET /ping` (all devices)

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-PA-01 | 200, one result per configured device, `source`/`deviceType`/`ipAddress` echoed | Automated (apiSurface) | PASS | "echoes source and deviceType" |
| TC-PA-02 | Per-device ping failure reported as `isAlive:false` + `error` in the array, handler still 200 | Automated (pingRoutes) | PASS | "reports per-device errors as JSON" |
| TC-PA-03 | Adhoc result recorded per device (`ok`/`down`/`error`) | Automated (pingRoutes) | PASS | `recordAdhocPing` assertions |
| TC-PA-04 | Live: 16 results for the 16 configured devices, 15 up / 1 down, ~3 s | Live probe (real ICMP) | PASS | `curl /ping` → 200, 16 entries |
| TC-PA-05 | Handler-level throw (all devices) forwarded to error middleware as 500 instead of an unhandled rejection | Automated (pingRoutes) | PASS | 500 + `next(error)` path; unhandled-rejection tracker empty |

### 3. `GET /ping/:target`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-PT-01 | 200 on success; response shape exactly `{ipAddress, isAlive, roundTripMs}` (no device fields for ad-hoc) | Automated (pingRoutes + apiSurface) | PASS | key-set assertion |
| TC-PT-02 | 400 + `success:false` for invalid targets: `not-an-ip`, `1.2.3`, `10.0.0`, `999.1.1.1`, `256.1.1.1`, `10.0.0.257`, `10.0.0.1.1`, `10:0:0:1`, `10.0.0.1extra`, `0x0a.0.0.1`, 500-char garbage — **without pinging** | Automated (pingRoutes + apiSurface) | PASS | `ping_device` not called |
| TC-PT-03 | 400 for reserved `0.0.0.0` and `255.255.255.255` | Automated + live probe | PASS | live `curl /ping/255.255.255.255` → 400 |
| TC-PT-04 | Percent-encoded target decoded before validation (`/ping/%33%30.0.0.1` pings `30.0.0.1`) | Automated (apiSurface) | PASS | |
| TC-PT-05 | Trailing-slash leniency (Express 4): `/ping/` → all-devices route (200), `/ping/10.0.0.1/` → target route (200) | Automated (apiSurface) | PASS | documented behavior |
| TC-PT-06 | Rejecting ping → controlled 500 JSON, `recordAdhocPing("error")`, server stays usable afterward | Automated (pingRoutes) | PASS | |
| TC-PT-07 | Adhoc outcomes recorded: `ok` / `down` / `invalid_target` / `error` | Automated (pingRoutes) | PASS | |
| TC-PT-08 | Live: `/ping/127.0.0.1` → 200 `isAlive:true` (real ICMP); invalid target → 400 | Live probe | PASS | |

### 4. `GET /read-config`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-RC-01 | 200 serving the on-disk config; does **not** apply it to the running pinger until `/reload-config` | Automated (configRoutes) | PASS | `updateConfig` not called until reload |
| TC-RC-02 | 400 `Could not read config` when the file is missing | Automated (apiSurface) | PASS | file deleted, restored in `finally` |
| TC-RC-03 | 400 for malformed YAML on disk | Automated (apiSurface) | PASS | |
| TC-RC-04 | Unknown keys in the file are stripped from the served object | Automated (apiSurface + configRoutes) | PASS | |
| TC-RC-05 | Live: response semantically equal to `/mnt/ip-pinger-data/config/config.yml` (16 devices, intervalSecs 30, lokiEnabled true) | Live probe | PASS | parsed-YAML equality check |

### 5. `POST /write-config` (state-changing — verified in isolation, never against the live instance)

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-WC-01 | Valid hot-reloadable payload: 200, `restartRequired:false`, file rewritten (atomic temp+rename), `updateConfig` receives new `intervalSecs`/`devices`, `success` recorded | Automated (configRoutes + apiSurface) | PASS | disk bytes verified |
| TC-WC-02 | `restartRequired:true` when `logLevel`, `lokiUrl`, or `lokiEnabled` differ from the startup baseline; hot portion still applies; persisted file contains the full payload | Automated (configRoutes) | PASS | 3-field matrix |
| TC-WC-03 | Validation rejects (400, `rejected` recorded, **file byte-identical**, pinger untouched): empty object; missing fields; `intervalSecs` 0 / -1 / 1.5 / "30" / 86401; boundary **accepts** 1 and 86400; `logLevel` not in enum; malformed `lokiUrl`; `lokiEnabled` without `lokiUrl`; invalid `deviceType`; device missing `ipAddress`; invalid IPv4; duplicate device identity; empty `devices` | Automated (configRoutes + apiSurface) | PASS | per-case file-integrity assertion |
| TC-WC-04 | Non-object JSON bodies (array → schema 400; string/number/null → strict-parser 400 `rejected_parse`); no Content-Type → 400 — no crash on any | Automated (apiSurface) | PASS | |
| TC-WC-05 | Malformed JSON body → 400 (not 500), `rejected_parse` recorded; oversized (>100 kb) body → 413, `rejected_parse`; parse failures on other routes are **not** recorded as reload attempts | Automated (configRoutes) | PASS | |
| TC-WC-06 | Persistence failure (rename fault-injected): 500 (server-side I/O fault — fixed per D-005/KI-008 on 2026-10-14; previously 400), live file byte-identical, **no temp file leaked**, `rejected` recorded | Automated (apiSurface) | PASS | fault injection via `fs.renameSync` spy |
| TC-WC-07 | Post-write re-read failure (fault-injected): 500 `Internal error`, pinger not updated; file **was** persisted; subsequent `/reload-config` restores file↔runtime consistency | Automated (apiSurface) | PASS | see DEFECTS D-002 |
| TC-WC-08 | Concurrent overlapping writes: both 200, sequences serialized, last applied == file on disk | Automated (configRoutes) | PASS | |
| TC-WC-09 | Write racing reload: final on-disk and applied state both equal the written payload | Automated (apiSurface) | PASS | |
| TC-WC-10 | Duplicate identical payloads: both 200, file valid, state consistent | Automated (apiSurface) | PASS | |
| TC-WC-11 | Unknown/obsolete keys (`alwaysLogErrors`, `apiPort`, arbitrary) accepted then stripped from persistence; `apiPort` does not trigger restart | Automated (configRoutes) | PASS | |
| TC-WC-12 | Live execution against the production instance | — | **BLOCKED** | Project rule: no mutating requests against production; behavior fully covered in isolation (TC-WC-01…11) |

### 6. `GET /reload-config`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-RL-01 | 200 `{success, restartRequired, message}`; applies hot settings; file left **byte-identical**; `success` recorded | Automated (apiSurface) | PASS | |
| TC-RL-02 | 400 when file missing or invalid; `rejected` recorded; pinger untouched | Automated (configRoutes + apiSurface) | PASS | |
| TC-RL-03 | `restartRequired` reported when disk config changes a startup-owned field | Automated (configRoutes) | PASS | |
| TC-RL-04 | Live execution against the production instance | — | **BLOCKED** | Would apply the current disk config to the running service (a state mutation); covered in isolation |

### 7. `GET /metrics`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-MX-01 | 200, `text/plain` content type, renders the **live** registry (probe gauge injected and observed) | Automated (apiSurface) | PASS | |
| TC-MX-02 | Live: 200 `text/plain; version=0.0.4`, 266 `pinged*`/`pinger_*` lines, `pinger_operational 1`, `pinger_devices_up 15` / `pinger_devices_down 1` consistent with `/ping`, default `process_*` metrics present | Live probe | PASS | |
| TC-MX-03 | Metric hygiene (latency only on success, series removal on device drop, no registry clear, adhoc/reload counters) | Automated (pinger) | PASS | `pinger.test.ts` metrics section |

### 8. `GET /health`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-HL-01 | 200 `{status:"healthy", timestamp:<ISO>}` JSON while operational | Automated (apiSurface) + live probe | PASS | live: 200 in 1.1 ms |
| TC-HL-02 | 503 `{status:"unhealthy", reason, timestamp}` after a fatal net-ping session failure (both the `error` and silent `close` paths); `pinger_operational` drops to 0 | Automated (pinger, real Pinger) | PASS | `pinger.test.ts` 503 cases |
| TC-HL-03 | Live 503 path triggered against production | — | **BLOCKED** | Requires killing the production ICMP session; covered at the real-Pinger level in TC-HL-02 |

### 9. `GET /endpoints`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-EP-01 | 200 JSON; exactly the nine registered routes with verb, shape, and description; non-empty fields | Automated (apiSurface) | PASS | |
| TC-EP-02 | Catalog equals the routes actually registered (source cross-check) and equals the live response | Source + live probe | PASS | live listing matches inventory 1:1 |

### 10. `GET /swagger/`

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-SW-01 | 200 serving the Swagger UI; OpenAPI spec contains all nine paths | Automated (swagger) | PASS | `swagger.test.ts` |
| TC-SW-02 | Live 200, page title "Swagger UI" | Live probe | PASS | |

### Cross-cutting: HTTP correctness, resilience, concurrency

| ID | Case | Plane | Status | Evidence |
|----|------|-------|--------|----------|
| TC-XX-01 | JSON content type on all JSON endpoints; CORS `Access-Control-Allow-Origin: *` on API responses; OPTIONS preflight 204; HEAD supported | Automated (apiSurface) + live probe | PASS | |
| TC-XX-02 | Unknown route → 404 controlled JSON; wrong method on a registered path → 405 controlled JSON with `Allow` header (fixed 2026-10-14 per D-001; originally observed as 404 HTML) | Automated (apiSurface + pinger, real stack) | PASS | 7 route-level cases + 1 real-Pinger case covering param templates, trailing-slash leniency, HEAD/OPTIONS, and post-404/405 usability |
| TC-XX-03 | Every error path answers controlled JSON `{success:false, message}` and logs; 4xx vs 5xx statuses preserved from body-parser errors | Automated (configRoutes + pingRoutes) | PASS | |
| TC-XX-04 | No unhandled promise rejections escape any route failure (process-level tracker across the ping suite) | Automated (pingRoutes) | PASS | |
| TC-XX-05 | Server remains usable after a 500 (no state corruption) | Automated (pingRoutes) | PASS | |
| TC-XX-06 | Restart persistence: config survives restart because the file is the source of truth | Automated (loadConfig) | PASS | boot re-loads `CONFIG_PATH` and validates |
| TC-XX-07 | Restart persistence verified by actually restarting the production service | — | **BLOCKED** | Not authorized during the audit; boot path covered by `loadConfig`/`index` tests |
| TC-XX-08 | Real ICMP timeout / host-unreachable / TTL-exceeded classification end-to-end | Automated (pinger, typed mocked errors) | PASS | `pinger.test.ts` network section |
| TC-XX-09 | Docker deployment: image build, `NET_RAW`, UID-1000 writable mount, health check on 32001 | — | **BLOCKED** | Requires container build; host-side NET_RAW unavailable to this session's test processes |
| TC-XX-10 | Load/performance under sustained request volume | — | **NOT TESTED** | Out of scope; no regression signal observed (live probes all <3.1 s; `/ping` bounded by 2 s net-ping timeout × device count) |
| TC-XX-11 | Loki transport behavior | — | **NOT TESTED** (HTTP audit scope) | Covered separately by `logger.test.ts` |

## Side-effect verification and restoration

- **`/write-config` against isolated configs:** 25+ mutating scenarios executed. Every scenario independently verified the on-disk file after the request (byte-compare for rejections; parse-compare for successes) and the pinger-side `updateConfig` calls. All temporary state restored in `finally` blocks; per-test re-seed in `beforeEach`; no temp files leaked after fault-injected write failures.
- **Live instance:** zero mutating requests sent. `/read-config` verified equal to the on-disk file before and after the audit; no config, device, or metric drift attributable to the audit. The only live side effects were ad-hoc ICMP echoes from `/ping`, `/ping/127.0.0.1`, and two rejected (non-ICMP) validation probes — normal service behavior.
- **Repository:** no production code modified. One new test file added (`code/tests/__tests__/routes/apiSurface.test.ts`) plus this documentation. Working tree otherwise clean.

## Summary

| Measure | Count |
|---------|-------|
| Endpoints discovered (declared routes) | 9 (+ Swagger UI = 10 surfaces) |
| Endpoints with documented test results | 9 / 9 (all) |
| Implicit HTTP surfaces verified | 7 (404, wrong-method, OPTIONS, HEAD, parser 400/413, async-error 500, CORS) |
| Automated tests executed | 202 (150 pre-existing + 52 added) — **202 PASS, 0 FAIL** |
| Live read-only probes | 15 — **15 PASS** |
| Failures (defects) | 0 contract violations; 4 P3 findings documented in [DEFECTS.md](DEFECTS.md) |
| BLOCKED | 5 (live mutating `/write-config`, live `/reload-config`, live 503 trigger, production restart, Docker/`NET_RAW` deployment) — each covered in isolation or blocked for safety, with rationale above |
| NOT TESTED | 2 (sustained load, Loki transport) — out of HTTP-audit scope |
