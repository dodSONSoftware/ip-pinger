/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import http from "http";
import { Pinger } from "../../../src/Pinger";
import { API_PORT, NoOpLogger } from "../../../src/common";
import { register } from "prom-client";
import type { Gauge } from "prom-client";
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
