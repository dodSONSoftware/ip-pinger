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
    apiPort: 3300,
    intervalSecs: 30,
    devices: [deviceA, deviceB],
    lokiEnabled: false,
};

function yamlFor(config: IConfig): string {
    const lines: string[] = [
        `logLevel: ${config.logLevel}`,
        `apiPort: ${config.apiPort}`,
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
    run: jest.fn(),
    ping_device: jest.fn(async (): Promise<[boolean, number]> => [true, 10]),
    updateConfig: updateConfig,
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
            apiPort: 3300,
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
        ["apiPort", { apiPort: 3301 }],
        ["logLevel", { logLevel: "debug" }],
        ["lokiUrl", { lokiUrl: "http://localhost:3100" }],
        ["lokiEnabled", { lokiEnabled: true }],
    ])("reports restartRequired when %s changes", async (_field, overrides) => {
        const { status, body } = await postConfig({
            logLevel: "info",
            apiPort: 3300,
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
            logLevel: "info",
            apiPort: 3399,
            intervalSecs: 50,
            lokiEnabled: false,
            devices: [deviceA],
        });

        expect(status).toBe(200);
        expect(body.restartRequired).toBe(true);

        // Hot-reloadable behavior changes immediately
        expect(appliedConfig().intervalSecs).toBe(50);

        // The persisted configuration contains the complete submitted
        // configuration, including the restart-required port change
        const read = await get("/read-config");
        expect(read.body.apiPort).toBe(3399);
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
    it("rejects invalid IPv4 addresses before persisting them", async () => {
        const before = fs.readFileSync(CONFIG_FILE, "utf-8");

        const { status, body } = await postConfig({
            logLevel: "info",
            apiPort: 3300,
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

describe("removed alwaysLogErrors option", () => {
    it("accepts payloads still containing the removed key and does not persist it", async () => {
        const { status } = await postConfig({
            logLevel: "info",
            apiPort: 3300,
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
