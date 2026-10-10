/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import express from "express";
import fs from "fs";
import http from "http";
import { createRoutes } from "../../../src/routes/generalRoutes";
import { NoOpLogger } from "../../../src/common";
import type { IConfig, IDevice, IPinger } from "../../../src/interfaces";

const CONFIG_FILE = "/tmp/test-config.yml";

const deviceA: IDevice = { source: "Device A", ipAddress: "10.0.0.1", deviceType: "sensor" };
const deviceB: IDevice = { source: "Device B", ipAddress: "10.0.0.2", deviceType: "server" };

// Configuration active at boot: its startup-owned values define the
// restart-required baseline the config endpoints compare against.
const startupConfig: IConfig = {
    logLevel: "info",
    intervalSecs: 30,
    devices: [deviceA, deviceB],
    lokiEnabled: false,
};

function yamlFor(config: IConfig): string {
    const lines: string[] = [
        `logLevel: ${config.logLevel}`,
        `intervalSecs: ${config.intervalSecs}`,
        `lokiEnabled: ${config.lokiEnabled}`,
    ];
    if (config.lokiUrl !== undefined) {
        lines.push(`lokiUrl: "${config.lokiUrl}"`);
    }
    lines.push("devices:");
    for (const device of config.devices) {
        lines.push(
            `  - source: "${device.source}"`,
            `    ipAddress: "${device.ipAddress}"`,
            `    deviceType: ${device.deviceType}`
        );
    }
    return lines.join("\n") + "\n";
}

// Test double for the running pinger: records the configuration the
// route handlers apply at runtime.
const updateConfig = jest.fn();
const fakePinger: IPinger = {
    start: jest.fn(async (): Promise<void> => { }),
    run: jest.fn(),
    ping_device: jest.fn(async (): Promise<[boolean, number]> => [true, 10]),
    updateConfig: updateConfig,
    isOperational: () => true,
    close: jest.fn(),
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
    // Seed the configuration file on disk with the boot configuration
    fs.writeFileSync(CONFIG_FILE, yamlFor(startupConfig));

    const app = express();
    // Pinger adds the JSON body parser before registering routes; mirror that
    // so /write-config receives a parsed req.body.
    app.use(express.json());
    createRoutes(app, startupConfig, yamlFor(startupConfig), fakePinger, new NoOpLogger(), new Date());
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
});

beforeEach(() => {
    updateConfig.mockClear();
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(baseUrl + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postConfig(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(baseUrl + "/write-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Raw-body variant: posts the string as-is so malformed JSON reaches the
// body parser instead of being stringified into a valid payload.
async function postRaw(body: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(baseUrl + "/write-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function appliedConfig(): IConfig {
    return updateConfig.mock.calls[0][0] as IConfig;
}

describe("/read-config (read-only)", () => {
    it("returns the on-disk config without updating the running pinger until /reload-config", async () => {
        const configB: IConfig = { ...startupConfig, intervalSecs: 45, devices: [deviceB] };
        fs.writeFileSync(CONFIG_FILE, yamlFor(configB));

        const read = await get("/read-config");
        expect(read.status).toBe(200);
        expect(read.body.intervalSecs).toBe(45);
        expect(read.body.devices as IDevice[]).toHaveLength(1);
        expect((read.body.devices as IDevice[])[0].ipAddress).toBe(deviceB.ipAddress);

        // The running pinger must not be updated by a read
        expect(updateConfig).not.toHaveBeenCalled();

        // /reload-config is the explicit operation that applies disk config
        const reload = await get("/reload-config");
        expect(reload.status).toBe(200);
        expect(reload.body.restartRequired).toBe(false);
        expect(updateConfig).toHaveBeenCalledTimes(1);
        expect(appliedConfig().intervalSecs).toBe(45);
        expect(appliedConfig().devices).toHaveLength(1);
        expect(appliedConfig().devices[0].ipAddress).toBe(deviceB.ipAddress);
    });
});

describe("/write-config (hot-reloadable settings)", () => {
    it("applies intervalSecs and devices changes immediately without a restart", async () => {
        const { status, body } = await postConfig({
            logLevel: "info",
            intervalSecs: 45,
            lokiEnabled: false,
            devices: [deviceA],
        });

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.restartRequired).toBe(false);
        expect(updateConfig).toHaveBeenCalledTimes(1);
        expect(appliedConfig().intervalSecs).toBe(45);
        expect(appliedConfig().devices).toHaveLength(1);
        expect(appliedConfig().devices[0].ipAddress).toBe(deviceA.ipAddress);
    });
});

describe("/write-config (restart-required settings)", () => {
    it.each([
        ["logLevel", { logLevel: "debug" }],
        ["lokiUrl", { lokiUrl: "http://localhost:3100" }],
        ["lokiEnabled", { lokiEnabled: true, lokiUrl: "http://localhost:3100" }],
    ])("reports restartRequired when %s changes", async (_field, overrides) => {
        const { status, body } = await postConfig({
            logLevel: "info",
            intervalSecs: 30,
            lokiEnabled: false,
            devices: [deviceA],
            ...overrides,
        });

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.restartRequired).toBe(true);
        // The hot-reloadable portion still applies immediately
        expect(updateConfig).toHaveBeenCalledTimes(1);
    });
});

describe("/write-config (mixed changes)", () => {
    it("applies hot-reloadable values immediately, reports restartRequired, and persists the full payload", async () => {
        const { status, body } = await postConfig({
            logLevel: "debug",
            intervalSecs: 50,
            lokiEnabled: false,
            devices: [deviceA],
        });

        expect(status).toBe(200);
        expect(body.restartRequired).toBe(true);

        // Hot-reloadable behavior changes immediately
        expect(appliedConfig().intervalSecs).toBe(50);

        // The persisted configuration contains the complete submitted
        // configuration, including the restart-required logLevel change
        const read = await get("/read-config");
        expect(read.body.logLevel).toBe("debug");
        expect(read.body.intervalSecs).toBe(50);
    });
});

describe("/reload-config (restart-required settings)", () => {
    it("reports restartRequired when the on-disk config changes a startup-owned field", async () => {
        fs.writeFileSync(CONFIG_FILE, yamlFor({ ...startupConfig, logLevel: "debug" }));

        const { status, body } = await get("/reload-config");
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.restartRequired).toBe(true);
        expect(updateConfig).toHaveBeenCalledTimes(1);
    });
});

describe("/write-config (validation)", () => {
    it("rejects enabling Loki without a lokiUrl before persisting it", async () => {
        const before = fs.readFileSync(CONFIG_FILE, "utf-8");

        const { status, body } = await postConfig({
            logLevel: "info",
            intervalSecs: 30,
            lokiEnabled: true,
            devices: [deviceA],
        });

        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(JSON.stringify(body.errors ?? "")).toContain("lokiUrl is required when lokiEnabled is true");
        expect(updateConfig).not.toHaveBeenCalled();
        expect(fs.readFileSync(CONFIG_FILE, "utf-8")).toBe(before);
    });

    it("rejects exact duplicate device definitions before persisting them", async () => {
        const before = fs.readFileSync(CONFIG_FILE, "utf-8");

        const { status, body } = await postConfig({
            logLevel: "info",
            intervalSecs: 30,
            lokiEnabled: false,
            devices: [
                { source: "Server A", ipAddress: "10.10.10.10", deviceType: "server" },
                { source: "Server A", ipAddress: "10.10.10.10", deviceType: "server" },
            ],
        });

        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(JSON.stringify(body.errors ?? "")).toContain("Duplicate device definition");
        expect(updateConfig).not.toHaveBeenCalled();
        expect(fs.readFileSync(CONFIG_FILE, "utf-8")).toBe(before);
    });

    it("rejects invalid IPv4 addresses before persisting them", async () => {
        const before = fs.readFileSync(CONFIG_FILE, "utf-8");

        const { status, body } = await postConfig({
            logLevel: "info",
            intervalSecs: 30,
            lokiEnabled: false,
            devices: [{ source: "Bad Device", ipAddress: "256.0.0.1", deviceType: "sensor" }],
        });

        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(updateConfig).not.toHaveBeenCalled();
        expect(fs.readFileSync(CONFIG_FILE, "utf-8")).toBe(before);
    });
});

describe("/write-config (malformed JSON body)", () => {
    it("answers a malformed JSON body with 400 instead of 500", async () => {
        const before = fs.readFileSync(CONFIG_FILE, "utf-8");

        const { status, body } = await postRaw('{"logLevel": "info",');

        // The body-parser message fragment varies by Node version, so only
        // assert on the middleware-owned prefix.
        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(String(body.message)).toContain("ERROR: POST /write-config failed");
        expect(updateConfig).not.toHaveBeenCalled();
        expect(fs.readFileSync(CONFIG_FILE, "utf-8")).toBe(before);
    });
});

describe("removed alwaysLogErrors option", () => {
    it("accepts payloads still containing the removed key and does not persist it", async () => {
        const { status } = await postConfig({
            logLevel: "info",
            intervalSecs: 30,
            lokiEnabled: false,
            devices: [deviceA],
            alwaysLogErrors: true,
        });

        expect(status).toBe(200);
        const read = await get("/read-config");
        expect(read.body.alwaysLogErrors).toBeUndefined();
    });
});

describe("multiple route instances (state isolation)", () => {
    const deviceA1: IDevice = { source: "A-1", ipAddress: "192.168.10.1", deviceType: "sensor" };
    const deviceA2: IDevice = { source: "A-2", ipAddress: "192.168.10.2", deviceType: "server" };
    const deviceB1: IDevice = { source: "B-1", ipAddress: "192.168.20.1", deviceType: "kiosk" };
    const deviceB2: IDevice = { source: "B-2", ipAddress: "192.168.20.2", deviceType: "server" };

    // Distinct startup baselines: A starts at logLevel "info", B at "error"
    const configA: IConfig = { logLevel: "info", intervalSecs: 30, devices: [deviceA1, deviceA2], lokiEnabled: false };
    const configB: IConfig = { logLevel: "error", intervalSecs: 30, devices: [deviceB1], lokiEnabled: false };

    const pingDeviceA = jest.fn(async (): Promise<[boolean, number]> => [true, 10]);
    const pingDeviceB = jest.fn(async (): Promise<[boolean, number]> => [true, 10]);
    const updateConfigA = jest.fn();
    const updateConfigB = jest.fn();
    const pingerA: IPinger = {
        start: jest.fn(async (): Promise<void> => { }),
        run: jest.fn(),
        ping_device: pingDeviceA,
        updateConfig: updateConfigA,
        isOperational: () => true,
        close: jest.fn(),
    };
    const pingerB: IPinger = {
        start: jest.fn(async (): Promise<void> => { }),
        run: jest.fn(),
        ping_device: pingDeviceB,
        updateConfig: updateConfigB,
        isOperational: () => true,
        close: jest.fn(),
    };

    // Distinct startup times: each instance's /about must report its own
    const bootA = new Date("2026-01-01T00:00:00.000Z");
    const bootB = new Date("2026-02-03T04:05:06.000Z");

    let serverA: http.Server;
    let serverB: http.Server;
    let baseUrlA: string;
    let baseUrlB: string;

    beforeAll(async () => {
        fs.writeFileSync(CONFIG_FILE, yamlFor(configA));

        const appA = express();
        appA.use(express.json());
        createRoutes(appA, configA, yamlFor(configA), pingerA, new NoOpLogger(), bootA);

        // Creating instance B must not rebind the routes registered for A
        const appB = express();
        appB.use(express.json());
        createRoutes(appB, configB, yamlFor(configB), pingerB, new NoOpLogger(), bootB);

        serverA = appA.listen(0);
        serverB = appB.listen(0);
        await Promise.all([
            new Promise<void>((resolve) => serverA.on("listening", () => resolve())),
            new Promise<void>((resolve) => serverB.on("listening", () => resolve())),
        ]);
        baseUrlA = `http://127.0.0.1:${(serverA.address() as { port: number }).port}`;
        baseUrlB = `http://127.0.0.1:${(serverB.address() as { port: number }).port}`;
    });

    afterAll(async () => {
        await Promise.all([
            new Promise<void>((resolve, reject) => serverA.close((error) => (error ? reject(error) : resolve()))),
            new Promise<void>((resolve, reject) => serverB.close((error) => (error ? reject(error) : resolve()))),
        ]);
    });

    beforeEach(() => {
        pingDeviceA.mockClear();
        pingDeviceB.mockClear();
        updateConfigA.mockClear();
        updateConfigB.mockClear();
    });

    async function getJson(base: string, path: string): Promise<{ status: number; body: unknown }> {
        const res = await fetch(base + path);
        return { status: res.status, body: await res.json() };
    }

    async function postConfigJson(base: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
        const res = await fetch(base + "/write-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    function pingSources(body: unknown): string[] {
        return (body as Array<{ source?: string }>).map((result) => result.source ?? "");
    }

    it("/ping/:target is answered by the owning pinger instance", async () => {
        const target = "10.9.9.9";

        const fromA = await getJson(baseUrlA, `/ping/${target}`);
        expect(fromA.status).toBe(200);
        expect(pingDeviceA).toHaveBeenCalledWith(target);
        expect(pingDeviceB).not.toHaveBeenCalled();

        const fromB = await getJson(baseUrlB, `/ping/${target}`);
        expect(fromB.status).toBe(200);
        expect(pingDeviceB).toHaveBeenCalledWith(target);
        // A was pinged exactly once, by its own request
        expect(pingDeviceA).toHaveBeenCalledTimes(1);
    });

    it("configuration mutation on one instance leaves the other's ping behavior and pinger untouched", async () => {
        // B adopts a new device list
        const writeB = await postConfigJson(baseUrlB, {
            logLevel: "error",
            intervalSecs: 42,
            lokiEnabled: false,
            devices: [deviceB1, deviceB2],
        });
        expect(writeB.status).toBe(200);
        expect(writeB.body.success).toBe(true);
        expect(updateConfigB).toHaveBeenCalledTimes(1);
        expect(updateConfigA).not.toHaveBeenCalled();

        // B's /ping now uses B's updated device list...
        const pingsB = await getJson(baseUrlB, "/ping");
        expect(pingSources(pingsB.body)).toEqual(["B-1", "B-2"]);
        // ...and A still pings its own device list, untouched by B's write
        const pingsA = await getJson(baseUrlA, "/ping");
        expect(pingSources(pingsA.body)).toEqual(["A-1", "A-2"]);
    });

    it("restart-required reporting stays based on each instance's startup baseline", async () => {
        // logLevel "info" matches A's startup baseline...
        const resA = await postConfigJson(baseUrlA, { ...configA, logLevel: "info" });
        expect(resA.status).toBe(200);
        expect(resA.body.restartRequired).toBe(false);

        // ...but differs from B's "error" startup baseline
        const resB = await postConfigJson(baseUrlB, { ...configB, logLevel: "info" });
        expect(resB.status).toBe(200);
        expect(resB.body.restartRequired).toBe(true);

        // After B's write, A's baseline is still A's own: the same payload
        // still reports no restart for A
        const resA2 = await postConfigJson(baseUrlA, { ...configA, logLevel: "info" });
        expect(resA2.body.restartRequired).toBe(false);
    });

    it("/about reports each instance's own boot date", async () => {
        const aboutA = await getJson(baseUrlA, "/about");
        expect(aboutA.status).toBe(200);
        expect((aboutA.body as { system: { bootdate: string } }).system.bootdate).toBe(bootA.toISOString());

        const aboutB = await getJson(baseUrlB, "/about");
        expect(aboutB.status).toBe(200);
        expect((aboutB.body as { system: { bootdate: string } }).system.bootdate).toBe(bootB.toISOString());
    });
});

describe("removed apiPort option", () => {
    it("ignores apiPort in write-config payloads and does not report a restart", async () => {
        const { status, body } = await postConfig({
            logLevel: "info",
            apiPort: 9999,
            intervalSecs: 30,
            lokiEnabled: false,
            devices: [deviceA],
        });

        // The fixed API port (32001) cannot be changed at runtime, so the
        // obsolete field must be dropped, not persisted as a mismatch source
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.restartRequired).toBe(false);
        const read = await get("/read-config");
        expect(read.body.apiPort).toBeUndefined();
    });
});
