/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { Logger } from "../../../src/Logger";
import { register } from "prom-client";
import type { IConfig } from "../../../src/interfaces";

function makeConfig(overrides: Partial<IConfig> = {}): IConfig {
    return {
        // "error" keeps the suites quiet: these tests assert on the
        // counters, not on the log output
        logLevel: "error",
        intervalSecs: 30,
        devices: [{ source: "Device A", ipAddress: "10.0.0.1", deviceType: "sensor" }],
        lokiEnabled: false,
        ...overrides,
    };
}

beforeEach(() => {
    // A Logger registers its counters in the shared registry; give each
    // construction a clean one
    register.clear();
});

describe("Logger (Loki transport metrics)", () => {
    it("exposes the Loki transport counters at zero while the transport is disabled", async () => {
        const logger = new Logger(makeConfig());

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_loki_send_failures_total 0$/m);
        expect(output).toMatch(/^pinger_loki_flush_timeouts_total 0$/m);
    });

    it("counts every failed Loki send, not just the sends that produce a warn", async () => {
        const logger = new Logger(makeConfig());
        // The winston-loki hook is private; the test drives it the way the
        // transport would
        const loki = logger as unknown as { onLokiConnectionError: (error: unknown) => void };

        loki.onLokiConnectionError(new Error("ECONNREFUSED"));
        loki.onLokiConnectionError(new Error("ECONNREFUSED"));

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_loki_send_failures_total 2$/m);
    });

    it("counts a flush that times out before Loki acknowledges", async () => {
        const logger = new Logger(makeConfig({ lokiEnabled: true, lokiUrl: "http://127.0.0.1:9" }));

        // The Loki transport (the last one added) starts a batch loop in
        // winston-loki's Batcher constructor, so keep the real transport
        // and stop it at the end — otherwise its timer keeps the jest
        // worker alive. The stand-in's flush never settles, so the
        // bounded wait times out.
        const never = new Promise<unknown>(() => undefined);
        const transports = (logger as unknown as { winston: { transports: Array<Record<string, unknown>> } }).winston.transports;
        const realLoki = transports[transports.length - 1] as { close: () => void };
        transports[transports.length - 1] = { flush: () => never };

        await logger.flush(50);

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_loki_flush_timeouts_total 1$/m);

        // Stop the Batcher's batch loop (its final flush is a no-op: no
        // entries were ever logged to the transport)
        realLoki.close();
    });

    it("does not count a flush that completes within the bound", async () => {
        const logger = new Logger(makeConfig());

        // No Loki transport: flush resolves immediately
        await logger.flush(50);

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_loki_flush_timeouts_total 0$/m);
    });
});
