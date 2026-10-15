# IP Pinger Services — API Audit Defects and Findings

Audit date: 2026-10-14. Severity scale: P0 = data loss / service down, P1 = major functional failure, P2 = significant functional or security issue, P3 = minor / cosmetic / hardening.

**No P0–P2 defects were found.** All 193 automated tests and 15 live read-only probes passed. The items below are P3 findings — four confirmed by direct evidence, two of which reconfirm already-documented known limitations. D-001, D-003, and D-005 were fixed on 2026-10-14 (see their resolution notes); the only open finding is D-004, a documented design limitation mitigated at the network layer.

## Confirmed findings

### D-001 — Method mismatch answered 404 HTML instead of 405 JSON (P3, confirmed — **fixed 2026-10-14**)

- **Observed:** `POST /health` (live) → `404`, `Content-Type: text/html`, Express default body. Same for any non-matching verb on a registered path. Unknown paths also 404 HTML.
- **Contract delta:** every application error path in `generalRoutes.ts` deliberately answers controlled JSON `{success:false, message}`; the method-mismatch and unknown-route surfaces bypassed that contract because Express 4's router falls method-mismatched requests through to the default finalhandler 404 (no 405 is synthesized for `app.route()` registrations).
- **Impact:** low. Clients got a correct non-2xx; only the body format (HTML vs JSON) was inconsistent with the rest of the API.
- **Resolution:** option (a) — a terminal middleware registered after all routes and before the error handler now answers unknown paths as 404 JSON and verb-mismatched registered paths as 405 JSON with an `Allow` header (`GET, HEAD` for GET routes, `POST` for `/write-config`). Path templates are matched against the same `endpointsInfo` catalog that serves `/endpoints` and `/about`, mirroring the router's own matching (no query string, one trailing slash lenient, `:param` = any single segment), so the surface cannot drift from the listing. Verified by 7 route-level cases plus a real-Pinger stack test. Take effect requires the next deployment.

### D-002 — `/write-config` can persist the file and still answer 500 (partial apply window) (P3, confirmed in test)

- **Reproduction (isolated, fault-injected — TC-WC-07):** validate → file write succeeds → the re-read inside `loadConfig()` fails (e.g., transient I/O error on `CONFIG_PATH`). Response: `500`, `success:false`, pinger **not** updated — but the file on disk **is** the new configuration.
- **Impact:** low and self-healing. Window is milliseconds (one `readFileSync` after the rename). File and runtime state disagree until the next `/reload-config` or restart; recovery was verified working in the same test. No corruption: the atomic rename guarantees the file holds a complete document either way.
- **Recommended correction:** in the `doWriteConfig` catch branch, note in the message that the payload may already be persisted and that `/reload-config` reconciles (or attempt one re-read retry before answering 500). Optional; the current behavior is predictable.

### D-003 — `X-Powered-By: Express` framework fingerprint (P3, confirmed — **fixed 2026-10-14**)

- **Observed:** header present on all responses, including live probes and OPTIONS preflight.
- **Impact:** informational disclosure only; combined with D-004 it slightly eases targeted attacks against known Express versions.
- **Resolution:** `this.express.disable("x-powered-by")` added to the Pinger constructor (`code/src/Pinger.ts`); regression test "does not advertise the framework (no X-Powered-By header) on API responses" in `code/tests/__tests__/pinger/pinger.test.ts` runs the real Pinger + Express stack and asserts the header is absent while the response stays intact. Take effect requires the next deployment.

### D-004 — No authentication; open `/write-config` and arbitrary-target ad-hoc ping (P3, reconfirms KI-001)

- **Observed:** all nine routes are unauthenticated (by design, per docs/Known Issues). `POST /write-config` rewrites the monitoring configuration for anyone who can reach port 32001; `GET /ping/:target` accepts any valid IPv4, letting a remote caller make the service emit ICMP to arbitrary destinations; `GET /read-config` exposes the full device inventory and the Loki URL.
- **Impact:** unchanged from the documented limitation; the audit reconfirms it is real and adds the ad-hoc-ping angle. Network segmentation is the mitigation (KI-001).
- **Recommended correction:** none beyond the existing KI-001 mitigation (restrict port 32001 to a trusted segment, or put an authenticating proxy in front).

### D-005 — Persistence I/O failures on `/write-config` answered 400, not 5xx (P3, reconfirmed KI-008 — **fixed 2026-10-14**)

- **Observed (TC-WC-06, fault-injected rename failure):** response `400` with `success:false` and a diagnostic message naming the path and OS error.
- **Impact:** a server-side I/O fault was reported with a client-error status; client-error monitoring would undercount genuine server faults.
- **Resolution:** the `/write-config` write-failure branch now answers `500`. The payload has already passed schema validation by that point, so every `write_file` failure reaching the branch is a server-side filesystem fault (EACCES/EBUSY/ENOSPC/…) — there is no client-error cause left to distinguish. The diagnostic message, the `pinger_config_reload_total{result="rejected"}` recording, the byte-intact file, and the no-temp-file-leak behavior are all unchanged and re-verified by the updated TC-WC-06. KI-008 marked resolved.

## Suspected and ruled out

| Suspicion | Result |
|-----------|--------|
| `/about` could keep reporting "healthy" while `/health` already 503s | Ruled out: `/about` computes status per request; verified at the real-Pinger level |
| Percent-encoded path parameters reaching the handler undecoded or mangled | Ruled out: `/ping/%33%30.0.0.1` correctly pings `30.0.0.1` (an initial audit misread of `%30` = `0` was an auditor error, not an app defect) |
| Concurrent `/write-config`/`/reload-config` interleaving could apply a payload the response did not claim | Ruled out: config-sequence lock verified under overlap (TC-WC-08/09) — last applied always equals file on disk |
| Failed rejections could partially modify or corrupt the config file | Ruled out: 25+ rejection scenarios all left the file byte-identical; atomic rename + no temp-file leakage verified under an injected write failure |
| A route failure could leave the server wedged or produce unhandled rejections | Ruled out: post-500 usability and process-level unhandled-rejection tracking both pass |

## Outstanding risks (prioritized)

1. **Network exposure of an unauthenticated mutating API** (D-004 / KI-001) — highest residual risk; mitigate at the network layer, not in code.
2. **Real-ICMP edge conditions** (timeout vs unreachable classification, session death) — verified with typed mocked errors only on this host (no `NET_RAW` for test processes); the live instance confirmed real up/down detection (15/16). Validate fatal-session behavior under the target container runtime per TESTING.md regression item 4.
3. **`/metrics` cardinality/memory at production scale** with frequent device churn — untested here; see KNOWN_ISSUES open verification items.
