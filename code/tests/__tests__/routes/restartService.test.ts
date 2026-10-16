/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import express from "express";
import net from "net";
import { createRoutes } from "../../../src/routes/generalRoutes";
import { NoOpLogger } from "../../../src/common";
import type { IConfig, IDevice, ILogger, IPinger } from "../../../src/interfaces";
import { validateRestartServiceToken } from "../../../src/restartService";
import type { RestartServiceOptions } from "../../../src/restartService";

// The injected callback is a jest mock, so no test in this suite can
// signal or exit the Jest process: the route under test only ever calls
// the mock, and the real shutdown path in index.ts is never imported.
const deviceA: IDevice = { source: "Device A", ipAddress: "10.0.0.1", deviceType: "sensor" };
const config: IConfig = { logLevel: "info", intervalSecs: 30, devices: [deviceA], lokiEnabled: false };

// Deterministic test secret at or above the 32-byte minimum the startup
// validation requires (the route never re-validates; production does it
// once at boot).
const TEST_TOKEN = "test-restart-secret-0123456789abcdef";

const fakePinger: IPinger = {
    start: jest.fn(async (): Promise<void> => { }),
    run: jest.fn(),
    ping_device: jest.fn(async (): Promise<[boolean, number]> => [true, 10]),
    updateConfig: jest.fn(),
    recordConfigReload: jest.fn(),
    recordAdhocPing: jest.fn(),
    isOperational: () => true,
    isClosed: () => false,
    close: jest.fn(),
};

function makeSpyLogger(): { logger: ILogger; info: jest.Mock; warn: jest.Mock; error: jest.Mock } {
    const info = jest.fn();
    const warn = jest.fn();
    const error = jest.fn();
    const debug = jest.fn();
    const logger: ILogger = {
        write_info: info,
        write_warn: warn,
        write_error: error,
        write_debug: debug,
    };
    return { logger, info, warn, error };
}

interface TestApp {
    baseUrl: string;
    port: number;
    close: () => Promise<void>;
}

// Builds the same stack the Pinger constructor installs (CORS, JSON body
// parser, then the route set) on an ephemeral port, so the tested surface
// matches the production registration order.
async function createApp(options?: RestartServiceOptions, logger?: ILogger): Promise<TestApp> {
    const app = express();
    // Pinger adds CORS and the JSON body parser before registering routes
    const cors = require("cors");
    app.use(cors());
    app.use(express.json());
    createRoutes(app, config, "config", fakePinger, logger ?? new NoOpLogger(), new Date("2026-10-01T00:00:00.000Z"), options);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const address = server.address() as { port: number };
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
}

function authHeader(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("timed out waiting for condition");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function readHeaders(socket: net.Socket): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        const ondata = (chunk: Buffer): void => {
            data += chunk.toString();
            if (data.includes("\r\n\r\n")) {
                socket.off("data", ondata);
                resolve(data);
            }
        };
        socket.on("data", ondata);
        socket.once("error", reject);
        socket.once("close", (): void => {
            if (!data.includes("\r\n\r\n")) {
                reject(new Error("connection closed before response headers"));
            }
        });
    });
}

describe("unauthenticated and wrong-verb surface", () => {
    const callback = jest.fn();
    const { logger, warn } = makeSpyLogger();
    let app: TestApp;

    beforeAll(async () => {
        app = await createApp({ token: TEST_TOKEN, requestRestart: callback }, logger);
    });

    afterAll(async () => {
        await app.close();
    });

    it("answers a missing Authorization header with 401, no shutdown scheduled", async () => {
        const res = await fetch(app.baseUrl + "/restart-service", { method: "POST" });
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(body).toEqual({ success: false, message: "Unauthorized." });
        expect(callback).not.toHaveBeenCalled();
    });

    it.each([
        ["lowercase scheme", `bearer ${TEST_TOKEN}`],
        ["empty token", "Bearer "],
        ["two tokens", `Bearer ${TEST_TOKEN} extra`],
        ["comma-joined duplicate headers", `Bearer ${TEST_TOKEN}, Bearer ${TEST_TOKEN}`],
    ])("answers a malformed header (%s) with 401, no shutdown scheduled", async (_label, header) => {
        const res = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: { Authorization: header } });
        await res.text();

        expect(res.status).toBe(401);
        expect(callback).not.toHaveBeenCalled();
    });

    it("answers a wrong token (same and different length) with 401, no shutdown scheduled", async () => {
        const sameLength = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader("wrong-restart-secret-0123456789abcdef") });
        const diffLength = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader("short") });
        await Promise.all([sameLength.text(), diffLength.text()]);

        expect(sameLength.status).toBe(401);
        expect(diffLength.status).toBe(401);
        expect(callback).not.toHaveBeenCalled();
    });

    it("answers GET and PUT with 405 Allow: POST, no shutdown scheduled", async () => {
        const get = await fetch(app.baseUrl + "/restart-service");
        const put = await fetch(app.baseUrl + "/restart-service", { method: "PUT" });
        const getBody = (await get.json()) as Record<string, unknown>;
        await put.text();

        expect(get.status).toBe(405);
        expect(get.headers.get("allow")).toBe("POST");
        expect(getBody.success).toBe(false);
        expect(put.status).toBe(405);
        expect(put.headers.get("allow")).toBe("POST");
        expect(callback).not.toHaveBeenCalled();
    });

    it("logs unauthorized attempts without the credential or its echo", () => {
        expect(warn).toHaveBeenCalled();
        for (const call of warn.mock.calls) {
            const text = JSON.stringify(call);
            expect(text).not.toContain(TEST_TOKEN);
            expect(text).not.toContain("Authorization");
        }
    });
});

describe("disabled endpoint (fail closed)", () => {
    it("answers 503 when no token is configured and never schedules a shutdown", async () => {
        const callback = jest.fn();
        const app = await createApp({ requestRestart: callback });
        try {
            const res = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            const body = (await res.json()) as Record<string, unknown>;

            expect(res.status).toBe(503);
            expect(body).toEqual({ success: false, message: "Restart endpoint is disabled." });
            expect(callback).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("answers 503 when a token is configured but no shutdown hook was injected", async () => {
        const app = await createApp({ token: TEST_TOKEN });
        try {
            const res = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            const body = (await res.json()) as Record<string, unknown>;

            expect(res.status).toBe(503);
            expect(body).toEqual({ success: false, message: "Restart endpoint is disabled." });
        } finally {
            await app.close();
        }
    });

    it("a set-but-weak token resolves to disabled at startup (503, boot continues) instead of failing the boot", async () => {
        // Before 2.0.0 a present-but-weak RESTART_SERVICE_TOKEN refused to
        // start. Now the composition root resolves each weak form to undefined
        // (the shared validity rule — see restartService.test.ts for the
        // warn), so the route layer sees a disabled endpoint and the service
        // still boots and serves.
        const callback = jest.fn();
        const weakTokens = ["short", "a".repeat(31), "a-1".repeat(16)];
        for (const weak of weakTokens) {
            const resolved = validateRestartServiceToken(weak);
            expect(resolved).toBeUndefined();

            const app = await createApp({ token: resolved, requestRestart: callback });
            try {
                const res = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
                const body = (await res.json()) as Record<string, unknown>;

                expect(res.status).toBe(503);
                expect(body).toEqual({ success: false, message: "Restart endpoint is disabled." });
                expect(callback).not.toHaveBeenCalled();
            } finally {
                await app.close();
            }
        }
    });
});

describe("one-shot acceptance", () => {
    it("accepts exactly one of two concurrent authorized requests; the duplicate gets 409", async () => {
        const callback = jest.fn();
        const app = await createApp({ token: TEST_TOKEN, requestRestart: callback });
        try {
            const [first, second] = await Promise.all([
                fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) }),
                fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) }),
            ]);
            const accepted = [first, second].find((res) => res.status === 202);
            const conflicted = [first, second].find((res) => res.status === 409);
            const acceptedBody = (await accepted!.json()) as Record<string, unknown>;
            const conflictedBody = (await conflicted!.json()) as Record<string, unknown>;

            expect(accepted).toBeDefined();
            expect(conflicted).toBeDefined();
            expect(accepted!.headers.get("cache-control")).toBe("no-store");
            expect(acceptedBody).toEqual({
                success: true,
                status: "restart_scheduled",
                message: "Service restart requested.",
            });
            expect(conflictedBody).toEqual({ success: false, message: "Restart already in progress." });
            // The shutdown runs exactly once, after the response completed
            await waitFor(() => callback.mock.calls.length === 1);
            expect(callback).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it("answers 409 to a sequential duplicate after the accepted request", async () => {
        const callback = jest.fn();
        const app = await createApp({ token: TEST_TOKEN, requestRestart: callback });
        try {
            const first = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            expect(first.status).toBe(202);
            await first.text();
            await waitFor(() => callback.mock.calls.length === 1);

            const second = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            const body = (await second.json()) as Record<string, unknown>;

            expect(second.status).toBe(409);
            expect(body).toEqual({ success: false, message: "Restart already in progress." });
            expect(callback).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it("runs the shutdown exactly once even when the client aborts an accepted response", async () => {
        const callback = jest.fn();
        const app = await createApp({ token: TEST_TOKEN, requestRestart: callback });
        try {
            const socket = net.connect(app.port, "127.0.0.1");
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", () => resolve());
                socket.once("error", reject);
            });
            socket.write(
                `POST /restart-service HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${app.port}\r\n` +
                `Authorization: Bearer ${TEST_TOKEN}\r\n` +
                `Connection: close\r\n\r\n`
            );
            // The request was acknowledged (the 202 headers are on the
            // wire), then the connection is torn down early: the restart
            // must still run, and only once, whichever response event
            // ('finish' or 'close') fires first.
            const headers = await readHeaders(socket);
            socket.destroy();
            expect(headers).toContain("202");

            await waitFor(() => callback.mock.calls.length === 1);
            expect(callback).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });

    it("contains a throwing injected handler: the 202 stands, the failure is logged, and no unhandled rejection escapes", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
        process.on("unhandledRejection", onUnhandled);
        const { logger, error } = makeSpyLogger();
        const callback = jest.fn((): void => { throw new Error("injected handler failure"); });
        const app = await createApp({ token: TEST_TOKEN, requestRestart: callback }, logger);
        try {
            const res = await fetch(app.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            const body = (await res.json()) as Record<string, unknown>;

            expect(res.status).toBe(202);
            expect(body.success).toBe(true);
            await waitFor(() => callback.mock.calls.length === 1);
            expect(callback).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith(
                expect.stringContaining("restart-service"),
                "Injected restart handler failed: Error: injected handler failure"
            );
            // Give a (hypothetical) rejected promise a tick to surface
            await new Promise((resolve) => setImmediate(resolve));
            expect(unhandled).toHaveLength(0);
        } finally {
            process.off("unhandledRejection", onUnhandled);
            await app.close();
        }
    });
});

describe("route catalog and instance isolation", () => {
    it("lists POST /restart-service exactly once in /endpoints and /about", async () => {
        const app = await createApp({ token: TEST_TOKEN, requestRestart: jest.fn() });
        try {
            const endpoints = await fetch(app.baseUrl + "/endpoints");
            const listed = ((await endpoints.json()) as { endpoints: Array<{ route: string; verb: string }> }).endpoints;
            const matches = listed.filter((entry) => entry.route === "/restart-service");
            expect(matches).toHaveLength(1);
            expect(matches[0].verb).toBe("POST");

            const about = await fetch(app.baseUrl + "/about");
            const commands = ((await about.json()) as { commands: { help: { commands: Array<{ route: string }> } } }).commands.help.commands;
            expect(commands.filter((command) => command.route === "/restart-service")).toHaveLength(1);
        } finally {
            await app.close();
        }
    });

    it("does not share restart state across independently constructed route sets", async () => {
        const callbackA = jest.fn();
        const callbackB = jest.fn();
        const appA = await createApp({ token: TEST_TOKEN, requestRestart: callbackA });
        const appB = await createApp({ token: TEST_TOKEN, requestRestart: callbackB });
        try {
            const firstA = await fetch(appA.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            expect(firstA.status).toBe(202);
            await firstA.text();
            await waitFor(() => callbackA.mock.calls.length === 1);

            // Instance A stays one-shot...
            const secondA = await fetch(appA.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            expect(secondA.status).toBe(409);
            await secondA.text();

            // ...while the independent instance B is still fully operational
            const firstB = await fetch(appB.baseUrl + "/restart-service", { method: "POST", headers: authHeader(TEST_TOKEN) });
            expect(firstB.status).toBe(202);
            await firstB.text();
            await waitFor(() => callbackB.mock.calls.length === 1);

            expect(callbackA).toHaveBeenCalledTimes(1);
            expect(callbackB).toHaveBeenCalledTimes(1);
        } finally {
            await appA.close();
            await appB.close();
        }
    });

    it("leaves the existing surface untouched", async () => {
        const app = await createApp({ token: TEST_TOKEN, requestRestart: jest.fn() });
        try {
            const health = await fetch(app.baseUrl + "/health");
            const body = (await health.json()) as Record<string, unknown>;
            expect(health.status).toBe(200);
            expect(body.status).toBe("healthy");

            const notFound = await fetch(app.baseUrl + "/no-such-path");
            await notFound.text();
            expect(notFound.status).toBe(404);
        } finally {
            await app.close();
        }
    });
});
