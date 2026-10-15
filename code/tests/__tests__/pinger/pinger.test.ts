/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import http from "http";
import { Pinger, PING_ERROR_TYPES } from "../../../src/Pinger";
import { API_PORT, NoOpLogger } from "../../../src/common";
import { register } from "prom-client";
import type { Counter, Gauge, Histogram } from "prom-client";
import type { IConfig, IDevice, ILogger } from "../../../src/interfaces";

const deviceA: IDevice = { source: "Device A", ipAddress: "10.0.0.1", deviceType: "sensor" };
const deviceB: IDevice = { source: "Device B", ipAddress: "10.0.0.2", deviceType: "server" };

function makeConfig(devices: IDevice[], overrides: Partial<IConfig> = {}): IConfig {
    return {
        logLevel: "info",
        intervalSecs: 30,
        devices,
        ...overrides,
    };
}

// The Pinger starts an Express server via start() on the fixed API port
// (API_PORT) unless a test-specific port is passed. Track every constructed
// Pinger so afterAll can close its server (and net-ping session) via
// close(), letting jest exit cleanly.
const pingers: Pinger[] = [];

async function createPinger(config: IConfig, port: number = 0): Promise<Pinger> {
    // port 0 = ephemeral port, so parallel pingers never collide
    const pinger = new Pinger(config, "initial config", new NoOpLogger(), new Date(), port);
    pingers.push(pinger);
    await pinger.start();
    return pinger;
}

afterAll(async () => {
    for (const pinger of pingers) {
        await pinger.close();
    }
});

afterEach(() => {
    // Give each Pinger construction a clean Prometheus registry
    register.clear();
});

describe("Pinger first configuration reload (stale Prometheus series)", () => {
    it("removes metric series for devices removed on the first reload after construction", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB]));
        const getUpGauge = () =>
            (pinger as unknown as { prometheus_Pinger_Up_Gauge: Gauge }).prometheus_Pinger_Up_Gauge;

        // Record values for both initial devices
        getUpGauge().set(
            { ipAddress: deviceA.ipAddress, deviceName: deviceA.source, deviceType: deviceA.deviceType },
            1
        );
        getUpGauge().set(
            { ipAddress: deviceB.ipAddress, deviceName: deviceB.source, deviceType: deviceB.deviceType },
            1
        );

        // First configuration update: drop device B
        pinger.updateConfig(makeConfig([deviceA]), "updated config");

        // The metric objects are process-lived (no rebuild on reload) — only
        // device B's series were removed — so record the kept device on the
        // same gauge
        getUpGauge().set(
            { ipAddress: deviceA.ipAddress, deviceName: deviceA.source, deviceType: deviceA.deviceType },
            1
        );

        const metrics = await register.metrics();

        // Device A remains...
        expect(metrics).toContain(`ipAddress="${deviceA.ipAddress}"`);
        // ...and removed device B leaves no series behind
        expect(metrics).not.toContain(`ipAddress="${deviceB.ipAddress}"`);
        expect(metrics).not.toContain(`deviceName="${deviceB.source}"`);
    });

    it("keeps every series when no devices are removed on the first reload", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB]));
        const getUpGauge = () =>
            (pinger as unknown as { prometheus_Pinger_Up_Gauge: Gauge }).prometheus_Pinger_Up_Gauge;

        getUpGauge().set(
            { ipAddress: deviceA.ipAddress, deviceName: deviceA.source, deviceType: deviceA.deviceType },
            1
        );
        getUpGauge().set(
            { ipAddress: deviceB.ipAddress, deviceName: deviceB.source, deviceType: deviceB.deviceType },
            1
        );

        // Interval-only change: no devices removed
        pinger.updateConfig(makeConfig([deviceA, deviceB], { intervalSecs: 45 }), "updated config");

        const metrics = await register.metrics();
        expect(metrics).toContain(`ipAddress="${deviceA.ipAddress}"`);
        expect(metrics).toContain(`ipAddress="${deviceB.ipAddress}"`);
    });
});

describe("Pinger.close() (lifecycle)", () => {
    it("closes the HTTP API server and the net-ping session", async () => {
        const netPing = jest.requireMock("net-ping") as { createSession: { mock: { results: Array<{ value: { close: jest.Mock } }> } } };
        const pinger = await createPinger(makeConfig([deviceA]));
        const session = netPing.createSession.mock.results.at(-1)!.value;
        const api_server = (pinger as unknown as { api_server: http.Server }).api_server;
        expect(api_server.listening).toBe(true);

        await pinger.close();

        expect(session.close).toHaveBeenCalledTimes(1);
        expect(api_server.listening).toBe(false);
    });
});

describe("Pinger closed state (main-loop guard)", () => {
    it("marks the pinger closed so a caller's run loop stops re-entering run()", async () => {
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 60 }));
        const session = latestSession();

        expect(pinger.isClosed()).toBe(false);
        const runPromise = pinger.run();

        // wait until the first cycle has completed and the loop is in the
        // 60-second wait (the steady state main() is in when a signal arrives)
        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m")) !== null;
        });

        await pinger.close();
        await runPromise;

        // The closed state is the caller's signal to stop looping...
        expect(pinger.isClosed()).toBe(true);

        // ...and re-entering run() on a closed pinger resolves promptly
        // (skipping the settle wait entirely) without starting a new cycle:
        // the spin main() must break out of
        const reentry_started = Date.now();
        await pinger.run();
        expect(Date.now() - reentry_started).toBeLessThan(500);
        expect(session.pingHost).toHaveBeenCalledTimes(1);
    }, 15000);
});

describe("Pinger.close() (in-flight ping cancellation at shutdown)", () => {
    it("treats pings aborted by close() as cancellations, not network failures", async () => {
        // Spy logger so a shutdown cancellation must not produce a
        // misleading ping-error log
        const write_error = jest.fn();
        const spyLogger: ILogger = {
            write_info: jest.fn(),
            write_warn: jest.fn(),
            write_error: write_error,
            write_debug: jest.fn(),
        };

        const pinger = new Pinger(makeConfig([deviceA, deviceB], { intervalSecs: 5 }), "initial config", spyLogger, new Date(), 0);
        pingers.push(pinger);
        await pinger.start();

        // Prior history: both devices were last seen up, and A carries a
        // known, pre-existing error
        const metrics = pingerMetrics(pinger);
        metrics.prometheus_Pinger_Up_Gauge.set(deviceALabels, 1);
        metrics.prometheus_Pinger_Up_Gauge.set(deviceBLabels, 1);
        metrics.prometheus_Pinger_Error_Total.inc({ ...deviceALabels, errorType: "timeout" });

        // Hold every ping in flight so close() finds them outstanding
        const netPing = jest.requireMock("net-ping") as { createSession: { mock: { results: Array<{ value: { pingHost: jest.Mock; close: jest.Mock } }> } } };
        const session = netPing.createSession.mock.results.at(-1)!.value;
        const pending: Array<(error: Error | null, target: string, sent: Date, received: Date) => void> = [];
        session.pingHost.mockImplementation((_host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            pending.push(callback);
        });

        // Mirror the real net-ping 1.2.4 behavior: closing the session
        // flushes every outstanding callback with a plain error
        session.close.mockImplementation(() => {
            for (const callback of pending) {
                callback(new Error("Socket forcibly closed"), "", new Date(), new Date());
            }
        });

        const runPromise = pinger.run();
        await waitFor(() => pending.length === 2);

        await pinger.close();
        await runPromise; // the cycle must settle with the cancelled results

        const output = await register.metrics();
        // Devices keep their last recorded state — not marked down by shutdown
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m"));
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceB.ipAddress}"[^}]*\\} 1$`, "m"));
        // No failure timestamp was recorded for either device (no labeled series)
        expect(output).not.toMatch(/(^|\n)pinged_last_failure_timestamp\{/);
        // Error counters unchanged: only A's pre-seeded timeout series exists
        expect(output).toMatch(new RegExp(`^pinged_errors_total\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*errorType="timeout"\\} 1$`, "m"));
        expect(output).not.toMatch(new RegExp(`pinged_errors_total\\{[^}]*ipAddress="${deviceB.ipAddress}"`));
        // No latency observation was recorded for the cancelled pings
        expect(output).not.toMatch(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress=`));
        // No misleading ping-error log was emitted for the cancellations
        expect(write_error).not.toHaveBeenCalled();
    }, 15000);
});

describe("Pinger lifecycle (run-loop wake semantics)", () => {
    it("a config update accepted mid-cycle applies at the cycle boundary, before the interval wait", async () => {
        // 60-second interval: if the pending update were only applied
        // after the old interval expired, the short wait timeout below
        // could never be met
        const pinger = await createPinger(makeConfig([deviceA, deviceB], { intervalSecs: 60 }));
        const metrics = pingerMetrics(pinger);
        // Prior history: B's up series must be gone after removal
        metrics.prometheus_Pinger_Up_Gauge.set(deviceBLabels, 1);

        // Hold B's ping in flight so the update arrives mid-cycle
        const session = latestSession();
        let staleB: ((error: Error | null, target: string, sent: Date, received: Date) => void) | undefined;
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            if (host === deviceB.ipAddress) {
                staleB = callback;
                return;
            }
            const sent = new Date();
            callback(null, host, sent, new Date(sent.getTime() + 5));
        });

        const runPromise = pinger.run();
        await waitFor(() => staleB !== undefined);

        pinger.updateConfig(makeConfig([deviceA], { intervalSecs: 1 }), "remove device B, shorten interval");

        // let the stale B ping finish: it is a completed observation under
        // the cycle's original snapshot, but the boundary application must
        // remove B's series before the wait begins
        staleB!(null, deviceB.ipAddress, new Date(), new Date());

        // verify promptly — no 60-second wait may be required
        await waitFor(async () => {
            const output = await register.metrics();
            const live = (pinger as unknown as { configuration: IConfig }).configuration;
            return !output.includes(deviceB.ipAddress)
                && live.devices.length === 1
                && live.intervalSecs === 1;
        }, 1000);

        await pinger.close();
        await runPromise;
    }, 15000);

    it("close() wakes the run loop from the inter-cycle wait instead of sleeping out the interval", async () => {
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 60 }));
        const runPromise = pinger.run();

        // wait until the first cycle has completed and the loop is in the
        // 60-second wait
        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m")) !== null;
        });

        const started = Date.now();
        await pinger.close();
        await runPromise;
        expect(Date.now() - started).toBeLessThan(500);
    }, 15000);
});

describe("Pinger.run() (fatal net-ping session error)", () => {
    // The mocked session exposes on() as a jest.fn(), so the listeners the
    // pinger registered can be retrieved and invoked
    interface SessionMock {
        pingHost: jest.Mock;
        close: jest.Mock;
        on: jest.Mock;
    }
    function sessionMock(): SessionMock {
        const netPing = jest.requireMock("net-ping") as {
            createSession: { mock: { results: Array<{ value: SessionMock }> } };
        };
        return netPing.createSession.mock.results.at(-1)!.value;
    }
    function sessionErrorListener(session: SessionMock): (error: Error) => void {
        const call = session.on.mock.calls.find((c) => c[0] === "error");
        if (!call) {
            throw new Error("no 'error' listener registered on the net-ping session mock");
        }
        return call[1] as (error: Error) => void;
    }
    function sessionCloseListener(session: SessionMock): () => void {
        const call = session.on.mock.calls.find((c) => c[0] === "close");
        if (!call) {
            throw new Error("no 'close' listener registered on the net-ping session mock");
        }
        return call[1] as () => void;
    }
    // Hold every ping in flight, and mirror the real net-ping 1.2.4
    // behavior: closing the session flushes every outstanding callback
    // with a plain error
    function flushOnClose(session: SessionMock): Array<(error: Error | null, target: string, sent: Date, received: Date) => void> {
        const pending: Array<(error: Error | null, target: string, sent: Date, received: Date) => void> = [];
        session.pingHost.mockImplementation((_host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            pending.push(callback);
        });
        session.close.mockImplementation(() => {
            for (const callback of pending) {
                callback(new Error("Socket forcibly closed"), "", new Date(), new Date());
            }
        });
        return pending;
    }
    function getHealth(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
        return new Promise((resolve, reject) => {
            http.get({ host: "127.0.0.1", port: port, path: "/health" }, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
                });
            }).on("error", reject);
        });
    }
    function getAbout(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
        return new Promise((resolve, reject) => {
            http.get({ host: "127.0.0.1", port: port, path: "/about" }, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
                });
            }).on("error", reject);
        });
    }

    it("run() rejects with the session error and in-flight pings are not recorded as device-down", async () => {
        // Spy logger so a fatal session error must surface as one
        // session-level error, not as per-device ping errors
        const write_error = jest.fn();
        const spyLogger: ILogger = {
            write_info: jest.fn(),
            write_warn: jest.fn(),
            write_error: write_error,
            write_debug: jest.fn(),
        };

        const pinger = new Pinger(makeConfig([deviceA, deviceB], { intervalSecs: 5 }), "initial config", spyLogger, new Date(), 0);
        pingers.push(pinger);
        await pinger.start();

        // Prior history: both devices were last seen up
        const metrics = pingerMetrics(pinger);
        metrics.prometheus_Pinger_Up_Gauge.set(deviceALabels, 1);
        metrics.prometheus_Pinger_Up_Gauge.set(deviceBLabels, 1);

        const session = sessionMock();
        const pending = flushOnClose(session);

        const runPromise = pinger.run();
        await waitFor(() => pending.length === 2);

        // The session fails unexpectedly while the cycle is in flight
        const sessionError = new Error("ICMP socket failed: ECONNRESET");
        sessionErrorListener(session)(sessionError);

        // The run loop terminates with the fatal session error
        await expect(runPromise).rejects.toBe(sessionError);

        // The pinger is no longer operational and the session was closed
        expect(pinger.isOperational()).toBe(false);
        expect(session.close).toHaveBeenCalledTimes(1);

        const output = await register.metrics();
        // The in-flight pings were recorded as cancellations, not failures:
        // devices keep their last recorded state (up)...
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m"));
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceB.ipAddress}"[^}]*\\} 1$`, "m"));
        // ...no failure timestamps were recorded...
        expect(output).not.toMatch(/(^|\n)pinged_last_failure_timestamp\{/);
        // ...no error-counter entries...
        expect(output).not.toMatch(/(^|\n)pinged_errors_total\{/);
        // ...and no latency observations
        expect(output).not.toMatch(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress=`));
        // The failure was logged once, as a session-level error — not as
        // per-device ping errors
        expect(write_error).toHaveBeenCalledTimes(1);
        expect(write_error.mock.calls[0][1]).toContain("ICMP socket failed: ECONNRESET");
    }, 15000);

    it("/health reports 200 healthy before the failure and 503 unhealthy after", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));
        const session = sessionMock();
        const port = ((pinger as unknown as { api_server: http.Server }).api_server.address() as { port: number }).port;

        expect(pinger.isOperational()).toBe(true);
        const healthy = await getHealth(port);
        expect(healthy.status).toBe(200);
        expect(healthy.body).toMatchObject({ status: "healthy" });
        // /about's system block reports the same operational state
        const aboutHealthy = await getAbout(port);
        expect((aboutHealthy.body.system as { status: string }).status).toBe("healthy");

        sessionErrorListener(session)(new Error("ICMP socket failed: ECONNRESET"));

        expect(pinger.isOperational()).toBe(false);
        const unhealthy = await getHealth(port);
        expect(unhealthy.status).toBe(503);
        expect(unhealthy.body).toMatchObject({ status: "unhealthy" });
        // ...and /about must not keep claiming "healthy"
        const aboutUnhealthy = await getAbout(port);
        expect(aboutUnhealthy.status).toBe(200);
        expect((aboutUnhealthy.body.system as { status: string }).status).toBe("unhealthy");
    });

    it("a subsequent run() rejects immediately with the same error without starting another cycle", async () => {
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 5 }));
        const session = sessionMock();
        const sessionError = new Error("ICMP socket failed: ECONNRESET");

        sessionErrorListener(session)(sessionError);

        // Every run() call must reject with the fatal error...
        await expect(pinger.run()).rejects.toBe(sessionError);
        await expect(pinger.run()).rejects.toBe(sessionError);
        // ...without attempting any ping on the closed session
        expect(session.pingHost).not.toHaveBeenCalled();
    });

    it("a session close without an error is fatal: run() rejects, pings cancel, /health goes 503", async () => {
        // Spy logger so a foreign close must surface as one session-level
        // error, not as per-device ping errors
        const write_error = jest.fn();
        const spyLogger: ILogger = {
            write_info: jest.fn(),
            write_warn: jest.fn(),
            write_error: write_error,
            write_debug: jest.fn(),
        };

        const pinger = new Pinger(makeConfig([deviceA, deviceB], { intervalSecs: 5 }), "initial config", spyLogger, new Date(), 0);
        pingers.push(pinger);
        await pinger.start();

        // Prior history: both devices were last seen up
        const metrics = pingerMetrics(pinger);
        metrics.prometheus_Pinger_Up_Gauge.set(deviceALabels, 1);
        metrics.prometheus_Pinger_Up_Gauge.set(deviceBLabels, 1);

        const session = sessionMock();
        const pending = flushOnClose(session);

        const runPromise = pinger.run();
        await waitFor(() => pending.length === 2);

        // The raw socket dies without an "error" event: only "close" fires.
        // Mirror the real net-ping 1.2.4 order — onSocketClose emits
        // "close" first, then flushes every outstanding callback with a
        // plain error — so the fatal state recorded by the "close" handler
        // is already visible to the flush.
        sessionCloseListener(session)();
        for (const callback of pending) {
            callback(new Error("Socket closed"), "", new Date(), new Date());
        }

        // The run loop terminates with the synthetic fatal error
        await expect(runPromise).rejects.toThrow("net-ping session closed unexpectedly");

        // The pinger is no longer operational and /health reports it
        expect(pinger.isOperational()).toBe(false);
        const port = ((pinger as unknown as { api_server: http.Server }).api_server.address() as { port: number }).port;
        const unhealthy = await getHealth(port);
        expect(unhealthy.status).toBe(503);

        const output = await register.metrics();
        // The in-flight pings were recorded as cancellations, not failures:
        // devices keep their last recorded state (up)...
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m"));
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceB.ipAddress}"[^}]*\\} 1$`, "m"));
        // ...no failure timestamps were recorded...
        expect(output).not.toMatch(/(^|\n)pinged_last_failure_timestamp\{/);
        // ...and no error-counter entries
        expect(output).not.toMatch(/(^|\n)pinged_errors_total\{/);
        // The failure was logged once, as a session-level error
        expect(write_error).toHaveBeenCalledTimes(1);
        expect(write_error.mock.calls[0][1]).toContain("net-ping session closed unexpectedly");
    }, 15000);

    it("an app-initiated close delivers a non-fatal close event", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));
        const session = sessionMock();

        expect(pinger.isOperational()).toBe(true);
        await pinger.close();
        // Deliver the "close" event that follows the app-initiated session
        // close: it must be logged, not recorded as a fatal failure
        sessionCloseListener(session)();

        expect(pinger.isOperational()).toBe(true);
    });
});

describe("Pinger.start() (API listener startup)", () => {
    it("resolves once the API server is listening", async () => {
        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date(), 0);
        pingers.push(pinger);

        await pinger.start();

        const api_server = (pinger as unknown as { api_server: http.Server }).api_server;
        expect(api_server.listening).toBe(true);
    });

    it("starts on the fixed API_PORT (32001) by default", async () => {
        expect(API_PORT).toBe(32001);

        // Construct without a test-specific port: the default must be 32001.
        // If the port is free the server binds 32001; if it is occupied, the
        // bind error names the port it attempted.
        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date());
        pingers.push(pinger);
        try {
            await pinger.start();
            const api_server = (pinger as unknown as { api_server: http.Server }).api_server;
            expect((api_server.address() as { port: number }).port).toBe(32001);
        } catch (error) {
            expect(String(error)).toContain("EADDRINUSE");
            expect(String(error)).toContain("32001");
        }
    });

    it("does not advertise the framework (no X-Powered-By header) on API responses", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));
        const port = ((pinger as unknown as { api_server: http.Server }).api_server.address() as { port: number }).port;

        const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
            http.get({ host: "127.0.0.1", port: port, path: "/health" }, (res) => {
                res.resume();
                res.on("end", () => resolve(res.headers));
            }).on("error", reject);
        });

        expect(headers["x-powered-by"]).toBeUndefined();
        // The suppression only removes the header; the response itself is intact
        expect(headers["content-type"]).toContain("application/json");
    });

    it("answers unmatched requests in the app's JSON error shape (404 unknown path, 405 wrong verb)", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));
        const port = ((pinger as unknown as { api_server: http.Server }).api_server.address() as { port: number }).port;

        const notFound = await fetch(`http://127.0.0.1:${port}/no-such-path`);
        expect(notFound.status).toBe(404);
        expect(notFound.headers.get("content-type")).toContain("application/json");
        expect(((await notFound.json()) as Record<string, unknown>).success).toBe(false);

        const notAllowed = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
        expect(notAllowed.status).toBe(405);
        expect(notAllowed.headers.get("content-type")).toContain("application/json");
        expect(notAllowed.headers.get("allow")).toBe("GET, HEAD");
        expect(((await notAllowed.json()) as Record<string, unknown>).success).toBe(false);
    });

    it("rejects when the API port is already in use (EADDRINUSE) and the pinger never reaches a listening state", async () => {
        // Occupy an ephemeral port with a throwaway server
        const blocker = http.createServer();
        await new Promise<void>((resolve) => blocker.once("listening", () => resolve()).listen(0));
        const blockerPort = (blocker.address() as { port: number }).port;

        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date(), blockerPort);
        pingers.push(pinger);

        await expect(pinger.start()).rejects.toThrow("EADDRINUSE");

        // The ping loop must not start: there is no listening API server
        const api_server = (pinger as unknown as { api_server?: http.Server }).api_server;
        expect(api_server?.listening ?? false).toBe(false);

        await new Promise<void>((resolve) => blocker.close(() => resolve()));
    });
});

describe("Pinger.updateConfig (hot-reloadable settings)", () => {
    it("applies new intervalSecs and devices to the running pinger immediately", async () => {
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 30 }));

        pinger.updateConfig(makeConfig([deviceA, deviceB], { intervalSecs: 45 }), "updated config");

        const live = (pinger as unknown as { configuration: IConfig }).configuration;
        expect(live.intervalSecs).toBe(45);
        expect(live.devices).toHaveLength(2);
        expect(live.devices.map((device) => device.ipAddress)).toEqual([deviceA.ipAddress, deviceB.ipAddress]);
    });
});

// Prometheus metric objects exposed privately by Pinger, for test assertions
function pingerMetrics(pinger: Pinger): {
    prometheus_Pinger_Up_Gauge: Gauge;
    prometheus_Pinger_Roundtrip_Histogram: Histogram;
    prometheus_Pinger_Cycle_Duration_Histogram: Histogram;
    prometheus_Pinger_Error_Total: Counter;
} {
    return pinger as unknown as {
        prometheus_Pinger_Up_Gauge: Gauge;
        prometheus_Pinger_Roundtrip_Histogram: Histogram;
        prometheus_Pinger_Cycle_Duration_Histogram: Histogram;
        prometheus_Pinger_Error_Total: Counter;
    };
}

const deviceALabels = { ipAddress: deviceA.ipAddress, deviceName: deviceA.source, deviceType: deviceA.deviceType };
const deviceBLabels = { ipAddress: deviceB.ipAddress, deviceName: deviceB.source, deviceType: deviceB.deviceType };

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    for (;;) {
        if (await check()) return;
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe("Pinger.updateConfig (Prometheus history preservation)", () => {
    it("removing device B preserves device A's error counter and drops B's series", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB]));
        const metrics = pingerMetrics(pinger);

        metrics.prometheus_Pinger_Error_Total.inc({ ...deviceALabels, errorType: "timeout" });
        metrics.prometheus_Pinger_Error_Total.inc({ ...deviceBLabels, errorType: "timeout" });

        pinger.updateConfig(makeConfig([deviceA]), "remove device B");

        const output = await register.metrics();
        // A's accumulated counter value survives the reload
        expect(output).toMatch(new RegExp(`^pinged_errors_total\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*errorType="timeout"\\} 1$`, "m"));
        // B leaves no series behind
        expect(output).not.toContain(deviceB.ipAddress);
    });

    it("removing device B preserves device A's roundtrip histogram and drops B's series", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB]));
        const metrics = pingerMetrics(pinger);

        metrics.prometheus_Pinger_Roundtrip_Histogram.observe(deviceALabels, 0.012);
        metrics.prometheus_Pinger_Roundtrip_Histogram.observe(deviceBLabels, 0.012);

        pinger.updateConfig(makeConfig([deviceA]), "remove device B");

        const output = await register.metrics();
        // A's histogram count and sum are intact
        expect(output).toMatch(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m"));
        expect(output).toMatch(new RegExp(`^pinged_roundtrip_seconds_sum\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 0\\.012$`, "m"));
        expect(output).not.toContain(deviceB.ipAddress);
    });

    it("removing a device does not reset the process-wide cycle duration histogram", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB]));
        const metrics = pingerMetrics(pinger);

        metrics.prometheus_Pinger_Cycle_Duration_Histogram.observe(1.5);
        metrics.prometheus_Pinger_Cycle_Duration_Histogram.observe(2.5);

        pinger.updateConfig(makeConfig([deviceA]), "remove device B");

        const output = await register.metrics();
        expect(output).toMatch(/pinger_cycle_duration_seconds_count 2/);
        expect(output).toMatch(/pinger_cycle_duration_seconds_sum 4/);
        expect(output).not.toContain(deviceB.ipAddress);
    });

    it("a stale in-flight ping for a removed device cannot leave metrics behind", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB], { intervalSecs: 1 }));
        const metrics = pingerMetrics(pinger);

        // Pre-existing history for both devices
        metrics.prometheus_Pinger_Up_Gauge.set(deviceALabels, 1);
        metrics.prometheus_Pinger_Up_Gauge.set(deviceBLabels, 1);
        metrics.prometheus_Pinger_Error_Total.inc({ ...deviceALabels, errorType: "timeout" });

        // Delay device B's ping completion so a removal can be requested
        // while that cycle is still in flight
        const netPing = jest.requireMock("net-ping") as { createSession: { mock: { results: Array<{ value: { pingHost: jest.Mock } }> } } };
        const session = netPing.createSession.mock.results.at(-1)!.value;
        let staleB: ((error: Error | null, target: string, sent: Date, received: Date) => void) | undefined;
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            if (host === deviceB.ipAddress) {
                staleB = callback;
                return;
            }
            const sent = new Date();
            callback(null, host, sent, new Date(sent.getTime() + 5));
        });

        const runPromise = pinger.run();

        // wait until the first cycle is in flight with B's ping pending
        await waitFor(() => staleB !== undefined);

        // request the removal mid-cycle; it must apply at the cycle boundary
        // (keep the short interval so the loop stays fast under the test clock)
        pinger.updateConfig(makeConfig([deviceA], { intervalSecs: 1 }), "remove device B");

        // let the stale B ping finish (it must not republish B after removal)
        staleB!(null, deviceB.ipAddress, new Date(), new Date());

        await waitFor(async () => !(await register.metrics()).includes(deviceB.ipAddress));

        const output = await register.metrics();
        expect(output).not.toContain(deviceB.ipAddress);
        // A's history survived the boundary application
        expect(output).toMatch(new RegExp(`^pinged_errors_total\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*errorType="timeout"\\} 1$`, "m"));

        await pinger.close();
        await runPromise;
    }, 15000);
});

describe("Pinger (application-level metrics)", () => {
    // The 'error' listener the pinger registered on the most recent
    // session mock (the helpers inside the fatal-session-error describe are
    // scoped there, so this describe keeps its own access path)
    function sessionErrorListener(): (error: Error) => void {
        const netPing = jest.requireMock("net-ping") as {
            createSession: { mock: { results: Array<{ value: { on: jest.Mock } }> } };
        };
        const session = netPing.createSession.mock.results.at(-1)!.value;
        const call = session.on.mock.calls.find((c) => c[0] === "error");
        if (!call) {
            throw new Error("no 'error' listener registered on the net-ping session mock");
        }
        return call[1] as (error: Error) => void;
    }

    it("exposes pinger_operational as 1 while the pinger can run cycles", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_operational 1$/m);

        await pinger.close();
    });

    it("reports pinger_operational 0 once the net-ping session has failed", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));

        sessionErrorListener()(new Error("ICMP socket failed: ECONNRESET"));

        expect(pinger.isOperational()).toBe(false);
        const output = await register.metrics();
        expect(output).toMatch(/^pinger_operational 0$/m);

        await pinger.close();
    });

    it("records pinger_last_cycle_timestamp when a cycle completes", async () => {
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 5 }));

        const runPromise = pinger.run();
        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m")) !== null;
        });

        const output = await register.metrics();
        const match = output.match(/^pinger_last_cycle_timestamp (\d+)$/m);
        expect(match).not.toBeNull();
        // the cycle just completed: the timestamp is close to now
        expect(Math.abs(Date.now() / 1000 - Number(match![1]))).toBeLessThan(60);

        await pinger.close();
        await runPromise;
    }, 15000);

    it("baselines the configuration metrics from the boot configuration", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB], { intervalSecs: 30 }));

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_config_devices 2$/m);
        expect(output).toMatch(/^pinger_config_pending_update 0$/m);
        expect(output).toMatch(/^pinger_config_loaded_timestamp \d+$/m);

        await pinger.close();
    });

    it("updates the configuration metrics when a new configuration is applied", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB], { intervalSecs: 30 }));

        pinger.updateConfig(makeConfig([deviceA, deviceB, { source: "Device C", ipAddress: "10.0.0.3", deviceType: "kiosk" }]), "add device C");

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_config_devices 3$/m);
        expect(output).toMatch(/^pinger_config_pending_update 0$/m);

        await pinger.close();
    });

    it("reports pinger_config_pending_update 1 while an update waits for the cycle boundary, 0 after it applies", async () => {
        const pinger = await createPinger(makeConfig([deviceA, deviceB], { intervalSecs: 60 }));
        const session = latestSession();
        let staleB: ((error: Error | null, target: string, sent: Date, received: Date) => void) | undefined;
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            if (host === deviceB.ipAddress) {
                staleB = callback;
                return;
            }
            const sent = new Date();
            callback(null, host, sent, new Date(sent.getTime() + 5));
        });

        const runPromise = pinger.run();
        await waitFor(() => staleB !== undefined);

        pinger.updateConfig(makeConfig([deviceA], { intervalSecs: 1 }), "remove device B");

        // the update is held pending while the cycle is still in flight
        let output = await register.metrics();
        expect(output).toMatch(/^pinger_config_pending_update 1$/m);

        // let the stale B ping finish: the boundary then applies the update
        staleB!(null, deviceB.ipAddress, new Date(), new Date());

        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(/^pinger_config_pending_update 0$/m) !== null;
        });
        output = await register.metrics();
        expect(output).toMatch(/^pinger_config_devices 1$/m);

        await pinger.close();
        await runPromise;
    }, 15000);

    it("counts configuration reload attempts by result", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));

        pinger.recordConfigReload("success");
        pinger.recordConfigReload("rejected");
        pinger.recordConfigReload("rejected");
        pinger.recordConfigReload("rejected_parse");

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_config_reload_total\{result="success"\} 1$/m);
        expect(output).toMatch(/^pinger_config_reload_total\{result="rejected"\} 2$/m);
        expect(output).toMatch(/^pinger_config_reload_total\{result="rejected_parse"\} 1$/m);

        await pinger.close();
    });

    it("counts on-demand /ping requests by result", async () => {
        const pinger = await createPinger(makeConfig([deviceA]));

        pinger.recordAdhocPing("ok");
        pinger.recordAdhocPing("down");
        pinger.recordAdhocPing("invalid_target");

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_adhoc_ping_total\{result="ok"\} 1$/m);
        expect(output).toMatch(/^pinger_adhoc_ping_total\{result="down"\} 1$/m);
        expect(output).toMatch(/^pinger_adhoc_ping_total\{result="invalid_target"\} 1$/m);

        await pinger.close();
    });

    it("observes pinger_cycle_delay_seconds for the inter-cycle wait", async () => {
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 1 }));

        const runPromise = pinger.run();
        // the settle wait (no cycle anchor) is not observed; the first
        // interval-elapsed wait ends when the second cycle starts
        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(/^pinger_cycle_delay_seconds_count\{reason="interval"\} [1-9]/m) !== null;
        });

        const output = await register.metrics();
        // a 1-second timer must not be late by more than a second
        const sum = Number(output.match(/^pinger_cycle_delay_seconds_sum\{reason="interval"\} ([0-9.]+)$/m)![1]);
        expect(sum).toBeLessThan(1);

        await pinger.close();
        await runPromise;
    }, 15000);
});

// Re-fetch the session mock created by the most recent Pinger construction
function latestSession(): { pingHost: jest.Mock } {
    const netPing = jest.requireMock("net-ping") as { createSession: { mock: { results: Array<{ value: { pingHost: jest.Mock } }> } } };
    return netPing.createSession.mock.results.at(-1)!.value;
}

// The mocked net-ping module, including the typed error classes that mirror
// the real library's exports
type MockNetPing = {
    createSession: { mock: { results: Array<{ value: { pingHost: jest.Mock } }> } };
    RequestTimedOutError: new () => Error;
    DestinationUnreachableError: new (source: string) => Error;
    TimeExceededError: new (source: string) => Error;
};
function mockNetPing(): MockNetPing {
    return jest.requireMock("net-ping") as MockNetPing;
}

describe("Pinger.run() (latency metrics only record successful pings)", () => {
    it("a successful ping updates the availability gauge, roundtrip gauge and records one histogram observation", async () => {
        // short interval so the run() loop exits promptly after close()
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 5 }));
        const session = latestSession();
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            const sent = new Date();
            callback(null, host, sent, new Date(sent.getTime() + 20)); // 20ms roundtrip
        });

        const runPromise = pinger.run();
        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m")) !== null;
        });

        const output = await register.metrics();
        // availability: up
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m"));
        // roundtrip gauge in milliseconds
        expect(output).toMatch(new RegExp(`^pinged_roundtrip_ms\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 20$`, "m"));
        // one histogram observation adding 20ms (0.020s) to the sum
        expect(output).toMatch(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m"));
        expect(output).toMatch(new RegExp(`^pinged_roundtrip_seconds_sum\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 0\\.02$`, "m"));

        await pinger.close();
        await runPromise;
    }, 15000);

    it("a failed ping updates the availability gauge but adds no histogram observation", async () => {
        // short interval so the run() loop exits promptly after close()
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 5 }));
        const session = latestSession();
        const { RequestTimedOutError } = mockNetPing();
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            callback(new RequestTimedOutError(), host, new Date(), new Date());
        });

        const runPromise = pinger.run();
        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 0$`, "m")) !== null;
        });

        const output = await register.metrics();
        // availability: down
        expect(output).toMatch(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 0$`, "m"));
        // the failure is counted under its error type...
        expect(output).toMatch(new RegExp(`^pinged_errors_total\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*errorType="timeout"\\} 1$`, "m"));
        // ...but produced no latency sample at all: no histogram count/sum series for the device
        expect(output).not.toMatch(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"`, "m"));
        expect(output).not.toMatch(new RegExp(`^pinged_roundtrip_seconds_sum\\{[^}]*ipAddress="${deviceA.ipAddress}"`, "m"));
        expect(output).not.toMatch(new RegExp(`^pinged_roundtrip_ms\\{[^}]*ipAddress="${deviceA.ipAddress}"`, "m"));

        await pinger.close();
        await runPromise;
    }, 15000);

    it("after a successful ping, a failed ping does not add a second histogram observation", async () => {
        // short interval so the follow-up (failing) cycle starts promptly
        // and the run() loop exits promptly after close()
        const pinger = await createPinger(makeConfig([deviceA], { intervalSecs: 2 }));
        const session = latestSession();
        const { RequestTimedOutError } = mockNetPing();
        let attempts = 0;
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            attempts++;
            if (attempts === 1) {
                const sent = new Date();
                callback(null, host, sent, new Date(sent.getTime() + 20)); // first cycle: success
            } else {
                callback(new RequestTimedOutError(), host, new Date(), new Date()); // later cycles: failure
            }
        });

        const runPromise = pinger.run();
        // wait until a failure has been recorded (the gauge flips to 0 after
        // the initial success)
        await waitFor(async () => {
            const output = await register.metrics();
            return output.match(new RegExp(`^pinged\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 0$`, "m")) !== null;
        });

        const output = await register.metrics();
        // exactly one observation, from the single successful ping
        expect(output).toMatch(new RegExp(`^pinged_roundtrip_seconds_count\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 1$`, "m"));
        expect(output).toMatch(new RegExp(`^pinged_roundtrip_seconds_sum\\{[^}]*ipAddress="${deviceA.ipAddress}"[^}]*\\} 0\\.02$`, "m"));

        await pinger.close();
        await runPromise;
    }, 20000);
});

describe("Pinger.run() (edge-triggered transition logging)", () => {
    // Spy logger so the transition lines can be asserted in isolation.
    // The Pinger ctor also writes info lines through it, so assertions
    // filter on message content instead of raw call counts.
    function makeSpyLogger(): { logger: ILogger; write_info: jest.Mock; write_error: jest.Mock } {
        const write_info = jest.fn();
        const write_error = jest.fn();
        const logger: ILogger = {
            write_info: write_info,
            write_warn: jest.fn(),
            write_error: write_error,
            write_debug: jest.fn(),
        };
        return { logger, write_info, write_error };
    }

    it("baselines the first observation silently, then logs down at error and up at info", async () => {
        const { logger, write_info, write_error } = makeSpyLogger();
        const pinger = new Pinger(makeConfig([deviceA], { intervalSecs: 1 }), "initial config", logger, new Date(), 0);
        pingers.push(pinger);
        await pinger.start();

        const session = latestSession();
        const { RequestTimedOutError } = mockNetPing();
        let alive = true;
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            if (alive) {
                const sent = new Date();
                callback(null, host, sent, new Date(sent.getTime() + 7));
            } else {
                callback(new RequestTimedOutError(), host, new Date(), new Date());
            }
        });

        const runPromise = pinger.run();

        // Cycle 1 (up): the first observation baselines silently — a
        // device already down before this process first pinged it did not
        // transition, so neither kind of line may exist yet
        await waitFor(() => session.pingHost.mock.calls.length >= 1);
        expect(write_info.mock.calls.map((c) => c[1]).filter((m: string) => m.includes("is back up"))).toHaveLength(0);
        expect(write_error.mock.calls.map((c) => c[1]).filter((m: string) => m.includes("went down"))).toHaveLength(0);

        // Cycle 2 (down): exactly one "went down" error, alongside the
        // pre-existing per-ping failure error
        alive = false;
        await waitFor(() => write_error.mock.calls.map((c) => c[1]).filter((m: string) => m.includes("went down")).length >= 1);

        // Cycle 3 (up): one "is back up" info carrying the roundtrip
        alive = true;
        await waitFor(() => write_info.mock.calls.map((c) => c[1]).filter((m: string) => m.includes("is back up")).length >= 1);

        await pinger.close();
        await runPromise;

        const infoMsgs = write_info.mock.calls.map((c) => c[1]);
        const errMsgs = write_error.mock.calls.map((c) => c[1]);
        expect(infoMsgs.filter((m) => m.includes("is back up"))).toHaveLength(1);
        expect(infoMsgs.filter((m) => m.includes("is back up"))[0]).toContain(`(${deviceA.source})`);
        expect(infoMsgs.filter((m) => m.includes("is back up"))[0]).toContain("7ms");
        expect(errMsgs.filter((m) => m.includes("went down"))).toHaveLength(1);
        expect(errMsgs.filter((m) => m.includes("went down"))[0]).toContain(`(${deviceA.source})`);
        // The per-cycle per-ping failure line is untouched: exactly one,
        // from the single failed cycle
        expect(errMsgs.filter((m) => m.includes("Device Error"))).toHaveLength(1);
    }, 15000);

    it("re-adding a removed device baselines silently instead of logging a stale transition", async () => {
        const { logger, write_info, write_error } = makeSpyLogger();
        const pinger = new Pinger(makeConfig([deviceA, deviceB], { intervalSecs: 1 }), "initial config", logger, new Date(), 0);
        pingers.push(pinger);
        await pinger.start();

        const session = latestSession();
        const { RequestTimedOutError } = mockNetPing();
        let deviceAUp = false; // A is down until just before it is re-added
        session.pingHost.mockImplementation((host: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void) => {
            if (host !== deviceA.ipAddress || deviceAUp) {
                const sent = new Date();
                callback(null, host, sent, new Date(sent.getTime() + 3));
            } else {
                callback(new RequestTimedOutError(), host, new Date(), new Date());
            }
        });

        const runPromise = pinger.run();

        // Cycle 1: A down (baselined), B up (baselined)
        await waitFor(() => session.pingHost.mock.calls.length >= 2);
        // Remove A while it is down; the update applies at the cycle
        // boundary (or immediately, if the boundary has passed)
        pinger.updateConfig(makeConfig([deviceB], { intervalSecs: 1 }), "remove device A");
        // Cycle 2: only B is pinged
        await waitFor(() => session.pingHost.mock.calls.length >= 3);
        // A recovers and is re-added
        deviceAUp = true;
        pinger.updateConfig(makeConfig([deviceB, deviceA], { intervalSecs: 1 }), "re-add device A");
        // Cycle 3: B and A are pinged; A's first observation since the
        // removal must baseline silently — if the removal had kept its
        // stale "down" state, an "is back up" line would appear here
        await waitFor(() => session.pingHost.mock.calls.length >= 5);

        await pinger.close();
        await runPromise;

        const transitionLines = [
            ...write_info.mock.calls.map((c) => c[1]),
            ...write_error.mock.calls.map((c) => c[1]),
        ].filter((m: string) => m.includes("is back up") || m.includes("went down"));
        expect(transitionLines).toHaveLength(0);
    }, 15000);
});

describe("Pinger error classification (getErrorType)", () => {
    function makeClassifier(): (error: Error) => string {
        // private method; construct without start() — no HTTP server involved
        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date(), 0);
        pingers.push(pinger);
        return (pinger as unknown as { getErrorType: (error: Error) => string }).getErrorType;
    }

    it("classifies every declared error type from the typed net-ping error classes", () => {
        const { RequestTimedOutError, DestinationUnreachableError, TimeExceededError } = mockNetPing();
        const classify = makeClassifier();

        expect(classify(new RequestTimedOutError())).toBe("timeout");
        expect(classify(new DestinationUnreachableError("10.0.0.1"))).toBe("host_unreachable");
        expect(classify(new TimeExceededError("10.0.0.1"))).toBe("ttl_exceeded");
        // plain Errors from the library (socket closed, unknown response type, ...)
        expect(classify(new Error("Socket closed"))).toBe("other");
        expect(classify(new Error("Unknown response type '99'"))).toBe("other");
    });

    it("never classifies by message text: an unrecognized message with a familiar word falls to other", () => {
        const classify = makeClassifier();

        // these messages contain the old classifier's trigger words but are
        // not the typed net-ping errors, so they must not be classified as
        // timeout / host_unreachable / ttl_exceeded
        expect(classify(new Error("timeout waiting for config"))).toBe("other");
        expect(classify(new Error("network interface changed"))).toBe("other");
        expect(classify(new Error("ttl exceeded in proxy chain"))).toBe("other");
    });

    it("declares only error types the runtime can actually classify", () => {
        // the taxonomy is bounded and contains no category without a real
        // producer: net-ping reports every destination-unreachable condition
        // as a single DestinationUnreachableError (the ICMP type/code is not
        // surfaced), so there is no distinguishable network_unreachable
        expect(PING_ERROR_TYPES).toEqual(["timeout", "host_unreachable", "ttl_exceeded", "other"]);

        // and the classifier only ever returns one of the declared values
        const { RequestTimedOutError, DestinationUnreachableError, TimeExceededError } = mockNetPing();
        const classify = makeClassifier();
        const samples: Error[] = [
            new RequestTimedOutError(),
            new DestinationUnreachableError("10.0.0.1"),
            new TimeExceededError("10.0.0.1"),
            new Error("Socket forcibly closed"),
            new Error("Too many requests outstanding"),
        ];
        for (const sample of samples) {
            expect(PING_ERROR_TYPES).toContain(classify(sample));
        }
    });
});

describe("Pinger route registration (error middleware ordering)", () => {
    it("installs the error-handling middleware after every route, including the swagger routes", () => {
        // constructed without start() — no HTTP server involved
        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date(), 0);
        pingers.push(pinger);

        // Express only forwards an error to error-handling layers registered
        // after the failing route: the shared error middleware must therefore
        // be the final layer of the app, so a failure in any route (including
        // /swagger) reaches it instead of Express's default 500 handler.
        type StackLayer = { handle: { length: number }; route?: { path: string }; regexp: { source: string } };
        const stack = (pinger as unknown as { express: { _router: { stack: StackLayer[] } } }).express._router.stack;
        const errorIdx = stack.findIndex((layer) => layer.handle.length === 4);
        const swaggerIdx = stack.findIndex((layer) => layer.regexp.source.includes("swagger"));

        expect(swaggerIdx).toBeGreaterThanOrEqual(0);
        expect(errorIdx).toBeGreaterThan(swaggerIdx);
        expect(errorIdx).toBe(stack.length - 1);
    });
});

describe("net-ping session options (session identifier)", () => {
    // The session identifier is created in the Pinger constructor, so these
    // tests construct without start() (no HTTP server) and read the options
    // the constructor handed to net-ping's createSession.
    function sessionOptions(): Record<string, unknown> {
        const netPing = jest.requireMock("net-ping") as {
            createSession: { mock: { calls: Array<Array<Record<string, unknown>>> } };
        };
        return netPing.createSession.mock.calls.at(-1)![0];
    }

    it("passes a non-zero session identifier within the ICMP identifier range", () => {
        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date(), 0);
        pingers.push(pinger);

        const sessionId = sessionOptions().sessionId as number;
        expect(Number.isInteger(sessionId)).toBe(true);
        expect(sessionId).toBeGreaterThanOrEqual(1);
        expect(sessionId).toBeLessThanOrEqual(65534);
    });

    it("falls back to identifier 1 when process.pid is a multiple of 65535", () => {
        // A pid that is a multiple of 65535 makes "pid % 65535" zero; the
        // guard normalizes that to 1 (not 65535, which net-ping's own
        // "% 65535" would fold back to 0).
        const originalPid = process.pid;
        try {
            Object.defineProperty(process, "pid", { value: 65535, configurable: true });
            const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date(), 0);
            pingers.push(pinger);

            expect(sessionOptions().sessionId).toBe(1);
        } finally {
            Object.defineProperty(process, "pid", { value: originalPid, configurable: true });
        }
    });
});
