/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import express from "express";
import fs from "fs";
import http from "http";
import { createRoutes, endpointsInfo } from "../../../src/routes/generalRoutes";
import { NoOpLogger } from "../../../src/common";
import { register, Gauge } from "prom-client";
import { APP_VERSION, APP_NAME } from "../../../src/version";
import type { IConfig, IDevice, IPinger } from "../../../src/interfaces";

// The worker-unique path jest.setup.js assigned to CONFIG_PATH: this suite
// writes, corrupts, and deletes the file around each scenario, so it must
// never share a path with another suite running in a different worker.
const CONFIG_FILE = process.env.CONFIG_PATH as string;

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

function yamlFor(config: IConfig, extraLines: string[] = []): string {
    const lines: string[] = [
        `logLevel: ${config.logLevel}`,
        `intervalSecs: ${config.intervalSecs}`,
        `lokiEnabled: ${config.lokiEnabled}`,
        ...extraLines,
        "devices:",
    ];
    if (config.lokiUrl !== undefined) {
        lines.push(`lokiUrl: "${config.lokiUrl}"`);
    }
    for (const device of config.devices) {
        lines.push(
            `  - source: "${device.source}"`,
            `    ipAddress: "${device.ipAddress}"`,
            `    deviceType: ${device.deviceType}`
        );
    }
    return lines.join("\n") + "\n";
}

// Test double for the running pinger: records the configuration the route
// handlers apply and the reload outcomes they report.
const pingDevice = jest.fn(async (): Promise<[boolean, number]> => [true, 10]);
const updateConfig = jest.fn();
const recordConfigReload = jest.fn();
const fakePinger: IPinger = {
    start: jest.fn(async (): Promise<void> => { }),
    run: jest.fn(),
    ping_device: pingDevice,
    updateConfig: updateConfig,
    recordConfigReload: recordConfigReload,
    recordAdhocPing: jest.fn(),
    isOperational: () => true,
    isClosed: () => false,
    close: jest.fn(),
};

let server: http.Server;
let baseUrl: string;
const bootDate = new Date("2026-10-01T00:00:00.000Z");

// A uniquely named metric proves the /metrics response is a live render of
// the process-wide Prometheus registry rather than a cached or static body.
const probeGauge = new Gauge({
    name: "api_surface_probe",
    help: "Test probe: proves /metrics renders the live registry.",
});

beforeAll(async () => {
    fs.writeFileSync(CONFIG_FILE, yamlFor(startupConfig));
    probeGauge.set(1);

    const app = express();
    // Pinger adds CORS and the JSON body parser before registering routes;
    // mirror both so the tested surface matches the production stack.
    const cors = require("cors");
    app.use(cors());
    app.use(express.json());
    createRoutes(app, startupConfig, yamlFor(startupConfig), fakePinger, new NoOpLogger(), bootDate);
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
    pingDevice.mockClear();
    pingDevice.mockResolvedValue([true, 10]);
    updateConfig.mockClear();
    recordConfigReload.mockClear();
    // Every test starts from the boot configuration on disk
    fs.writeFileSync(CONFIG_FILE, yamlFor(startupConfig));
});

async function get(path: string): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
    const res = await fetch(baseUrl + path);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, headers: res.headers };
}

async function postConfig(payload: unknown, raw?: string): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
    const res = await fetch(baseUrl + "/write-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw ?? JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        logLevel: "info",
        intervalSecs: 30,
        lokiEnabled: false,
        devices: [deviceA],
        ...overrides,
    };
}

function readDiskYaml(): string {
    return fs.readFileSync(CONFIG_FILE, "utf-8");
}

describe("response surface (headers, shapes, and live registries)", () => {
    it("/about answers 200 JSON with the about, system, and commands blocks", async () => {
        const { status, body, headers } = await get("/about");
        const about = body as {
            about: Record<string, string>;
            system: { status: string; bootdate: string };
            commands: { name: string; help: { description: string; commands: { route: string; description: string }[] } };
        };

        expect(status).toBe(200);
        expect(headers.get("content-type")).toContain("application/json");
        expect(about.about.name).toBe("IP Pinger Services");
        expect(about.about.version).toBe(APP_VERSION);
        expect(about.about.release).toBe(APP_NAME);
        expect(about.about.license).toBe("MIT License");
        expect(about.system.status).toBe("healthy");
        expect(about.system.bootdate).toBe(bootDate.toISOString());
        // The about command index is derived from the /endpoints catalog
        expect(about.commands.help.commands).toEqual(
            endpointsInfo.endpoints.map(({ route, description }) => ({ route, description }))
        );
    });

    it("/endpoints lists every registered route with verb, shape, and description", async () => {
        const { status, body, headers } = await get("/endpoints");
        const listed = (body as { endpoints: { name: string; route: string; verb: string; responseBody: string; description: string }[] }).endpoints;

        expect(status).toBe(200);
        expect(headers.get("content-type")).toContain("application/json");
        expect(listed).toHaveLength(9);
        const routes = new Set(listed.map((entry) => `${entry.verb} ${entry.route}`));
        expect(routes).toEqual(new Set([
            "GET /about",
            "GET /ping",
            "GET /ping/:target",
            "GET /read-config",
            "POST /write-config",
            "GET /reload-config",
            "GET /metrics",
            "GET /health",
            "GET /endpoints",
        ]));
        for (const entry of listed) {
            expect(entry.name.length).toBeGreaterThan(0);
            expect(entry.responseBody.length).toBeGreaterThan(0);
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });

    it("/health answers 200 with an ISO timestamp while operational", async () => {
        const { status, body, headers } = await get("/health");
        const health = body as { status: string; timestamp: string };

        expect(status).toBe(200);
        expect(headers.get("content-type")).toContain("application/json");
        expect(health.status).toBe("healthy");
        expect(Number.isNaN(Date.parse(health.timestamp))).toBe(false);
    });

    it("/metrics answers 200 text/plain and renders the live Prometheus registry", async () => {
        const res = await fetch(baseUrl + "/metrics");
        const text = await res.text();

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/plain");
        expect(text).toContain("api_surface_probe 1");
        // The default Node process metrics live on the same endpoint in the
        // production layout (index.ts calls collectDefaultMetrics); the
        // service-owned pinger metrics are created by the Pinger class, not
        // by these routes, so only the probe gauge is asserted here.
    });

    it("CORS allows any origin on the API responses", async () => {
        const { headers } = await get("/about");
        expect(headers.get("access-control-allow-origin")).toBe("*");
    });
});

describe("/ping/:target (parameter edge cases)", () => {
    it.each([
        "1.2.3",
        "10.0.0",
        "999.1.1.1",
        "10.0.0.1extra",
        "0x0a.0.0.1",
        "a".repeat(500),
    ])("rejects %s with a 400 without pinging", async (raw) => {
        const { status, body } = await get(`/ping/${encodeURIComponent(raw)}`);

        expect(status).toBe(400);
        expect((body as { success: boolean }).success).toBe(false);
        expect(pingDevice).not.toHaveBeenCalled();
    });

    it("decodes a percent-encoded valid IPv4 target and pings it", async () => {
        // %33%30 is "30": Express decodes path parameters before the
        // handler sees them, so the schema validates the decoded address
        const { status, body } = await get("/ping/%33%30.0.0.1");

        expect(status).toBe(200);
        expect(pingDevice).toHaveBeenCalledWith("30.0.0.1");
        expect((body as { ipAddress: string }).ipAddress).toBe("30.0.0.1");
    });

    it("answers an ad-hoc ping with only ipAddress, isAlive, and roundTripMs", async () => {
        const { body } = await get("/ping/10.0.0.1");

        expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(["ipAddress", "isAlive", "roundTripMs"]);
    });

    it("treats trailing slashes leniently: /ping/ is the all-devices route, /ping/:target/ is the target route", async () => {
        // Express 4 (strict routing off) strips the trailing slash:
        // /ping/ answers as /ping (one result per configured device) and
        // /ping/10.0.0.1/ answers as /ping/10.0.0.1 (a single ad-hoc ping)
        const all = await get("/ping/");
        expect(all.status).toBe(200);
        expect(Array.isArray(all.body)).toBe(true);
        expect((all.body as unknown[]).length).toBe(2);

        const one = await get("/ping/10.0.0.1/");
        expect(one.status).toBe(200);
        expect(pingDevice).toHaveBeenCalledWith("10.0.0.1");
        expect((one.body as { ipAddress: string }).ipAddress).toBe("10.0.0.1");
    });
});

describe("/ping (all configured devices)", () => {
    it("echoes source and deviceType for each configured device, one result per device", async () => {
        pingDevice.mockResolvedValue([true, 10]);
        const { status, body } = await get("/ping");
        const results = body as Array<Record<string, unknown>>;

        expect(status).toBe(200);
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.source)).toEqual(["Device A", "Device B"]);
        expect(results.map((r) => r.ipAddress)).toEqual(["10.0.0.1", "10.0.0.2"]);
        expect(results.map((r) => r.deviceType)).toEqual(["sensor", "server"]);
    });
});

describe("/write-config (validation boundaries)", () => {
    // Every rejected payload must leave the on-disk file byte-identical and
    // must not touch the running pinger.
    function expectRejected(status: number, body: Record<string, unknown>): void {
        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(updateConfig).not.toHaveBeenCalled();
        expect(recordConfigReload).toHaveBeenCalledWith("rejected");
        expect(readDiskYaml()).toBe(yamlFor(startupConfig));
    }

    it("rejects an empty object, naming the missing required fields", async () => {
        const { status, body } = await postConfig({});

        expectRejected(status, body);
        const errors = JSON.stringify(body.errors ?? "");
        expect(errors).toContain("logLevel");
        expect(errors).toContain("intervalSecs");
        expect(errors).toContain("devices");
    });

    it("accepts the minimum interval (1s) and the maximum interval (one day)", async () => {
        for (const intervalSecs of [1, 24 * 60 * 60]) {
            const { status, body } = await postConfig(basePayload({ intervalSecs }));

            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(updateConfig).toHaveBeenCalledWith(
                expect.objectContaining({ intervalSecs }),
                expect.any(String)
            );
            // restore for the next iteration
            fs.writeFileSync(CONFIG_FILE, yamlFor(startupConfig));
            updateConfig.mockClear();
        }
    });

    it.each([
        ["zero", 0],
        ["negative", -1],
        ["fractional", 1.5],
        ["numeric string", "30"],
        ["above one day", 24 * 60 * 60 + 1],
    ])("rejects intervalSecs %s", async (_label, intervalSecs) => {
        const { status, body } = await postConfig(basePayload({ intervalSecs: intervalSecs as number }));
        expectRejected(status, body);
    });

    it("rejects a logLevel outside the debug/info/warn/error set", async () => {
        const { status, body } = await postConfig(basePayload({ logLevel: "verbose" }));
        expectRejected(status, body);
    });

    it("rejects a malformed lokiUrl", async () => {
        const { status, body } = await postConfig(basePayload({ lokiUrl: "not a url", lokiEnabled: true }));
        expectRejected(status, body);
    });

    it("rejects a deviceType outside the sensor/server/kiosk set", async () => {
        const { status, body } = await postConfig(basePayload({
            devices: [{ source: "Router", ipAddress: "10.0.0.9", deviceType: "router" }],
        }));
        expectRejected(status, body);
    });

    it("rejects a device entry missing its ipAddress", async () => {
        const { status, body } = await postConfig(basePayload({
            devices: [{ source: "Ghost", deviceType: "sensor" }],
        }));
        expectRejected(status, body);
    });

    it("rejects an empty devices array", async () => {
        const { status, body } = await postConfig(basePayload({ devices: [] }));

        expectRejected(status, body);
        expect(JSON.stringify(body.errors ?? "")).toContain("at least one device");
    });

    it("rejects an array body at the schema boundary", async () => {
        // Arrays pass the strict-mode parser and are refused by the schema
        const { status, body } = await postConfig([1, 2, 3]);
        expectRejected(status, body);
    });

    it.each([
        ["a string body", "info"],
        ["a number body", 42],
        ["a null body", null],
    ])("rejects a non-object JSON body (%s) at the parser boundary", async (_label, payload) => {
        // body-parser runs in strict mode: only objects and arrays are
        // accepted as JSON bodies, so a scalar JSON value is a parse
        // failure (400) that the error middleware records as
        // rejected_parse rather than a schema rejection
        const { status, body } = await postConfig(payload);

        expect(status).toBe(400);
        expect(body.success).toBe(false);
        expect(updateConfig).not.toHaveBeenCalled();
        expect(recordConfigReload).toHaveBeenCalledWith("rejected_parse");
        expect(readDiskYaml()).toBe(yamlFor(startupConfig));
    });

    it("rejects a POST with no JSON content type instead of crashing", async () => {
        const res = await fetch(baseUrl + "/write-config", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "logLevel: info",
        });
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(400);
        expect(body.success).toBe(false);
        expect(updateConfig).not.toHaveBeenCalled();
        expect(readDiskYaml()).toBe(yamlFor(startupConfig));
    });

    it("accepts the same IP under different sources (distinct identities)", async () => {
        const { status, body } = await postConfig(basePayload({
            devices: [
                { source: "First", ipAddress: "10.0.0.50", deviceType: "sensor" },
                { source: "Second", ipAddress: "10.0.0.50", deviceType: "server" },
            ],
        }));

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(updateConfig).toHaveBeenCalledTimes(1);
    });

    it("strips unknown keys from the persisted configuration", async () => {
        const { status } = await postConfig(basePayload({ someCustomKey: "drop me" }));

        expect(status).toBe(200);
        const read = await get("/read-config");
        expect((read.body as Record<string, unknown>).someCustomKey).toBeUndefined();
    });
});

describe("/write-config (persistence and failure paths)", () => {
    it("answers 500 when the atomic rename fails (server-side I/O fault, not a client error), leaving the live file untouched and no temp file behind", async () => {
        const renameSpy = jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
            throw new Error("simulated rename failure");
        });

        try {
            const { status, body } = await postConfig(basePayload({ intervalSecs: 41 }));

            // The payload validated, so the failure is a filesystem fault on
            // CONFIG_PATH: a genuine server failure that must not masquerade
            // as a 4xx client error (KI-008 / D-005)
            expect(status).toBe(500);
            expect(body.success).toBe(false);
            expect(String(body.message)).toContain("Failed to write file");
            expect(recordConfigReload).toHaveBeenCalledWith("rejected");
            expect(updateConfig).not.toHaveBeenCalled();
            expect(readDiskYaml()).toBe(yamlFor(startupConfig));
            // The temp-file cleanup in write_file must not leak: temp
            // files are named `${CONFIG_FILE}.<pid>.<n>.tmp` in /tmp
            const leaked = fs.readdirSync("/tmp").filter((name) => name.startsWith(`${CONFIG_FILE}.`) && name.endsWith(".tmp"));
            expect(leaked).toHaveLength(0);
        } finally {
            renameSpy.mockRestore();
        }
    });

    it("answers 500 when the post-write re-read fails, persists nothing usable, and /reload-config restores consistency", async () => {
        // The write succeeds (rename is real); the re-read inside
        // loadConfig fails once, so the payload is persisted but never
        // applied to the running pinger — the documented recovery is a
        // subsequent /reload-config.
        const readSpy = jest.spyOn(fs, "readFileSync").mockImplementationOnce((): string => {
            throw new Error("simulated read failure");
        });

        try {
            const { status, body } = await postConfig(basePayload({ intervalSecs: 41 }));

            expect(status).toBe(500);
            expect(body.success).toBe(false);
            expect(String(body.message)).toContain("Internal error");
            // D-002: the file was written before the re-read failed, so the
            // message must warn that the payload may already be persisted and
            // point at /reload-config as the reconciliation path
            expect(String(body.message)).toContain("may already be persisted");
            expect(String(body.message)).toContain("/reload-config");
            expect(recordConfigReload).toHaveBeenCalledWith("rejected");
            expect(updateConfig).not.toHaveBeenCalled();
            // The write landed on disk before the re-read failed
            expect(readDiskYaml()).toContain("intervalSecs: 41");
        } finally {
            readSpy.mockRestore();
        }

        // Recovery: the reload picks up the persisted configuration
        const reload = await get("/reload-config");
        expect(reload.status).toBe(200);
        expect((reload.body as { success: boolean }).success).toBe(true);
        expect(updateConfig).toHaveBeenCalledWith(
            expect.objectContaining({ intervalSecs: 41 }),
            expect.any(String)
        );
    });

    it("applies identical duplicate payloads twice without corruption", async () => {
        const payload = basePayload({ intervalSecs: 55 });

        const first = await postConfig(payload);
        const second = await postConfig(payload);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect((first.body as { success: boolean }).success).toBe(true);
        expect((second.body as { success: boolean }).success).toBe(true);
        expect(updateConfig).toHaveBeenCalledTimes(2);

        const read = await get("/read-config");
        expect((read.body as { intervalSecs: number }).intervalSecs).toBe(55);
        expect((read.body as { devices: IDevice[] }).devices).toHaveLength(1);
    });
});

describe("/read-config (failure modes)", () => {
    it("answers 400 when the configuration file is missing", async () => {
        fs.unlinkSync(CONFIG_FILE);
        try {
            const { status, body } = await get("/read-config");

            expect(status).toBe(400);
            expect(String((body as { message: unknown }).message)).toContain("Could not read config");
        } finally {
            fs.writeFileSync(CONFIG_FILE, yamlFor(startupConfig));
        }
    });

    it("answers 400 when the on-disk file is malformed YAML", async () => {
        const before = readDiskYaml();
        fs.writeFileSync(CONFIG_FILE, "intervalSecs: [unclosed\n");
        try {
            const { status, body } = await get("/read-config");

            expect(status).toBe(400);
            expect(String((body as { message: unknown }).message)).toContain("Could not read config");
        } finally {
            fs.writeFileSync(CONFIG_FILE, before);
        }
    });

    it("strips unknown keys from the served configuration", async () => {
        fs.writeFileSync(CONFIG_FILE, yamlFor(startupConfig, ["alwaysLogErrors: true"]));

        const { status, body } = await get("/read-config");

        expect(status).toBe(200);
        expect((body as Record<string, unknown>).alwaysLogErrors).toBeUndefined();
        expect((body as { intervalSecs: number }).intervalSecs).toBe(30);
    });
});

describe("unmatched requests (404 / 405 surface)", () => {
    async function drain(res: Response): Promise<void> {
        await res.text();
    }

    it("answers an unknown path with 404 JSON in the app's error shape", async () => {
        const res = await fetch(baseUrl + "/no-such-path");
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(body.success).toBe(false);
        expect(String(body.message)).toContain("not found");
    });

    it("answers an unknown path with a query string as 404 (the query does not create a route)", async () => {
        const res = await fetch(baseUrl + "/no-such-path?target=10.0.0.1");
        await drain(res);

        expect(res.status).toBe(404);
    });

    it("answers a registered path with a wrong verb as 405 JSON with an Allow header", async () => {
        const res = await fetch(baseUrl + "/health", { method: "POST" });
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(405);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(res.headers.get("allow")).toBe("GET, HEAD");
        expect(body.success).toBe(false);
        expect(String(body.message)).toContain("method not allowed");
    });

    it("answers GET on the POST-only /write-config with 405 Allow: POST", async () => {
        const res = await fetch(baseUrl + "/write-config");
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        expect(body.success).toBe(false);
    });

    it("answers HEAD on the POST-only /write-config with 405 (HEAD is not auto-allowed there)", async () => {
        const res = await fetch(baseUrl + "/write-config", { method: "HEAD" });

        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        await drain(res);
    });

    it("matches parameter templates and trailing-slash leniency: POST /ping/:target is 405, deeper paths are 404", async () => {
        const plain = await fetch(baseUrl + "/ping/10.0.0.1", { method: "POST" });
        const trailing = await fetch(baseUrl + "/ping/10.0.0.1/", { method: "POST" });
        const allRoute = await fetch(baseUrl + "/ping/", { method: "POST" });
        const deeper = await fetch(baseUrl + "/ping/10.0.0.1/deep", { method: "POST" });

        expect(plain.status).toBe(405);
        expect(plain.headers.get("allow")).toBe("GET, HEAD");
        expect(trailing.status).toBe(405);
        expect(allRoute.status).toBe(405);
        expect(deeper.status).toBe(404);
        await Promise.all([plain, trailing, allRoute, deeper].map(drain));
    });

    it("keeps every registered route working after 404/405 answers", async () => {
        const notFound = await fetch(baseUrl + "/nope");
        const notAllowed = await fetch(baseUrl + "/health", { method: "DELETE" });
        await Promise.all([notFound, notAllowed].map(drain));

        const health = await get("/health");
        expect(health.status).toBe(200);
        expect((health.body as { status: string }).status).toBe("healthy");
    });
});

describe("/reload-config (consistency)", () => {
    it("reloads without modifying the file and reports the standard shape", async () => {
        const before = readDiskYaml();
        const { status, body, headers } = await get("/reload-config");

        expect(status).toBe(200);
        expect(headers.get("content-type")).toContain("application/json");
        expect(body).toEqual({ success: true, restartRequired: false, message: "Configuration reloaded successfully." });
        expect(updateConfig).toHaveBeenCalledTimes(1);
        expect(recordConfigReload).toHaveBeenCalledWith("success");
        expect(readDiskYaml()).toBe(before);
    });

    it("answers 400 when the configuration file is missing", async () => {
        fs.unlinkSync(CONFIG_FILE);
        try {
            const { status, body } = await get("/reload-config");

            expect(status).toBe(400);
            expect((body as { success: boolean }).success).toBe(false);
            expect(updateConfig).not.toHaveBeenCalled();
        } finally {
            fs.writeFileSync(CONFIG_FILE, yamlFor(startupConfig));
        }
    });

    it("keeps file and applied state consistent when a write and a reload race", async () => {
        // The disk holds intervalSecs 42 while the write submits 41. Under
        // the config-sequence lock the two operations serialize: whichever
        // runs first, the later one re-reads the file, so the final state
        // on disk and in the pinger must both be the written 41.
        fs.writeFileSync(CONFIG_FILE, yamlFor({ ...startupConfig, intervalSecs: 42 }));

        const [write, reload] = await Promise.all([
            postConfig(basePayload({ intervalSecs: 41 })),
            get("/reload-config"),
        ]);

        expect(write.status).toBe(200);
        expect(reload.status).toBe(200);
        expect(updateConfig).toHaveBeenCalledTimes(2);
        const lastApplied = updateConfig.mock.calls[updateConfig.mock.calls.length - 1][0] as IConfig;
        expect(lastApplied.intervalSecs).toBe(41);
        expect(readDiskYaml()).toContain("intervalSecs: 41");
    });
});
