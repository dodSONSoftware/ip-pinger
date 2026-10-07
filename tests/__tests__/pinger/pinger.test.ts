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
import { LogLevel } from "../../../src/interfaces";

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

        // Cleanup rebuilds the device gauges; record the kept device on the new gauge
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

describe("Pinger.close() (in-flight ping cancellation at shutdown)", () => {
    it("treats pings aborted by close() as cancellations, not network failures", async () => {
        // Spy logger so a shutdown cancellation must not produce a
        // misleading ping-error log
        const write_error = jest.fn();
        const spyLogger: ILogger = {
            global_log_level: (): LogLevel => LogLevel.None,
            global_log_level_string: (): string => "None",
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

    it("run() rejects with the session error and in-flight pings are not recorded as device-down", async () => {
        // Spy logger so a fatal session error must surface as one
        // session-level error, not as per-device ping errors
        const write_error = jest.fn();
        const spyLogger: ILogger = {
            global_log_level: (): LogLevel => LogLevel.None,
            global_log_level_string: (): string => "None",
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

        sessionErrorListener(session)(new Error("ICMP socket failed: ECONNRESET"));

        expect(pinger.isOperational()).toBe(false);
        const unhealthy = await getHealth(port);
        expect(unhealthy.status).toBe(503);
        expect(unhealthy.body).toMatchObject({ status: "unhealthy" });
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
});

describe("Pinger.start() (API listener startup)", () => {
    it("resolves once the API server is listening", async () => {
        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date(), 0);
        pingers.push(pinger);

        await pinger.start();

        const api_server = (pinger as unknown as { api_server: http.Server }).api_server;
        expect(api_server.listening).toBe(true);
    });

    it("starts on the fixed API_PORT (3300) by default", async () => {
        expect(API_PORT).toBe(3300);

        // Construct without a test-specific port: the default must be 3300.
        // If the port is free the server binds 3300; if it is occupied, the
        // bind error names the port it attempted.
        const pinger = new Pinger(makeConfig([deviceA]), "initial config", new NoOpLogger(), new Date());
        pingers.push(pinger);
        try {
            await pinger.start();
            const api_server = (pinger as unknown as { api_server: http.Server }).api_server;
            expect((api_server.address() as { port: number }).port).toBe(3300);
        } catch (error) {
            expect(String(error)).toContain("EADDRINUSE");
            expect(String(error)).toContain("3300");
        }
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
