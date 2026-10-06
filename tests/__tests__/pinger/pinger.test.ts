/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import http from "http";
import { Pinger } from "../../../src/Pinger";
import { API_PORT, NoOpLogger } from "../../../src/common";
import { register } from "prom-client";
import type { Counter, Gauge, Histogram } from "prom-client";
import type { IConfig, IDevice } from "../../../src/interfaces";

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
