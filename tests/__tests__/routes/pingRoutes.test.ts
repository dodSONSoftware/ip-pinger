/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import express from "express";
import http from "http";
import { createRoutes } from "../../../src/routes/generalRoutes";
import { NoOpLogger } from "../../../src/common";
import type { IConfig, IDevice, IPinger } from "../../../src/interfaces";

const deviceA: IDevice = { source: "Device A", ipAddress: "10.0.0.1", deviceType: "sensor" };

const startupConfig: IConfig = {
    logLevel: "info",
    intervalSecs: 30,
    devices: [deviceA],
    lokiEnabled: false,
};

const pingDevice = jest.fn(async (): Promise<[boolean, number]> => [true, 10]);

// Test double for the running pinger; the handlers resolve ping_device
// through the object at request time, so the mock behavior can be swapped
// per test.
const fakePinger: IPinger = {
    start: jest.fn(async (): Promise<void> => { }),
    run: jest.fn(),
    ping_device: pingDevice,
    updateConfig: jest.fn(),
    isOperational: () => true,
    close: jest.fn(),
};

let server: http.Server;
let baseUrl: string;

// Express 4 does not forward rejected async handlers to its error path, so
// a regression here surfaces as an unhandled rejection rather than a failed
// request. Track rejections for the lifetime of the test process and fail
// the suite if any escaped the route handlers.
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
};

beforeAll(async () => {
    process.on("unhandledRejection", onUnhandledRejection);

    const app = express();
    app.use(express.json());
    createRoutes(app, startupConfig, "", fakePinger, new NoOpLogger(), new Date());
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    process.off("unhandledRejection", onUnhandledRejection);
});

beforeEach(() => {
    pingDevice.mockClear();
    // Default back to a healthy pinger
    pingDevice.mockResolvedValue([true, 10]);
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(baseUrl + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterAll(() => {
    // No route failure may escape as an unhandled rejection
    expect(unhandledRejections).toHaveLength(0);
});

describe("/ping/:target (async error handling)", () => {
    it("answers a rejecting ping_device with a logged 500 instead of an unhandled rejection", async () => {
        pingDevice.mockRejectedValue(new Error("simulated ping failure"));

        const { status, body } = await get("/ping/10.0.0.1");

        expect(status).toBe(500);
        expect(body.success).toBe(false);
        expect(String(body.message)).toContain("simulated ping failure");
    });

    it("keeps the server usable after a ping failure", async () => {
        // Force one failure first...
        pingDevice.mockRejectedValue(new Error("simulated ping failure"));
        const failed = await get("/ping/10.0.0.1");
        expect(failed.status).toBe(500);

        // ...then confirm the same server still answers requests normally
        pingDevice.mockResolvedValue([true, 12]);
        const ok = await get("/ping/10.0.0.1");
        expect(ok.status).toBe(200);
        expect(ok.body.isAlive).toBe(true);
        expect(ok.body.roundTripMs).toBe(12);
    });

    it("returns 200 when the ping succeeds", async () => {
        pingDevice.mockResolvedValue([false, 0]);
        const { status, body } = await get("/ping/10.0.0.1");
        expect(status).toBe(200);
        expect(body.isAlive).toBe(false);
        expect(body.roundTripMs).toBe(0);
    });
});

describe("/ping/:target (target validation)", () => {
    it.each([
        "not-an-ip",
        "256.1.1.1",
        "10.0.0.1.1",
        "10.0.0.257",
        "10:0:0:1",
    ])("rejects %s with a 400 without pinging", async (target) => {
        const { status, body } = await get(`/ping/${target}`);

        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(String(body.message)).toContain("not a valid IPv4 address");
        expect(pingDevice).not.toHaveBeenCalled();
    });
});

describe("/ping (async error handling)", () => {
    it("reports per-device errors as JSON instead of rejecting the handler", async () => {
        pingDevice.mockRejectedValue(new Error("simulated ping failure"));

        const res = await fetch(baseUrl + "/ping");
        expect(res.status).toBe(200);
        const body = (await res.json()) as { error?: string; isAlive: boolean }[];
        expect(body).toHaveLength(1);
        expect(body[0].isAlive).toBe(false);
        expect(body[0].error).toContain("simulated ping failure");
    });
});
