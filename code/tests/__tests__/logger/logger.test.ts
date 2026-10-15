/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { Logger } from "../../../src/Logger";
import { register } from "prom-client";
import type { IConfig } from "../../../src/interfaces";
import http from "http";
import type { AddressInfo } from "net";

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
        // A second back-to-back flush against the same unacknowledged queue
        // must stay bounded and never throw — an overlapping shutdown and
        // terminal exit can flush twice — and each timed-out call counts.
        await logger.flush(50);

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_loki_flush_timeouts_total 2$/m);

        // Stop the Batcher's batch loop (its final flush is a no-op: no
        // entries were ever logged to the transport)
        realLoki.close();
    });

    it("flush() sends the pending batch immediately instead of waiting out the 5 s send cycle", async () => {
        // A real Loki transport (real Batcher, default 5 s send interval)
        // pointed at a local stand-in server. Without the immediate-send
        // trigger in flush(), an entry logged just after construction sits
        // in the batch until the next scheduled tick up to 5 s away —
        // beyond any bounded wait — and is lost when the process exits
        // after the flush (the graceful-shutdown tail-loss race). The
        // bound below is well under the 5 s interval, so only the
        // immediate trigger can deliver the batch in time.
        let receivedSends = 0;
        const server = http.createServer((req, res) => {
            receivedSends++;
            req.resume();
            req.on("end", () => {
                res.writeHead(204);
                res.end();
            });
        });
        await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
        const address = server.address() as AddressInfo;
        const logger = new Logger(makeConfig({
            lokiEnabled: true,
            lokiUrl: `http://127.0.0.1:${address.port}`,
        }));
        // Keep a handle on the real transport so the Batcher's batch loop
        // can be stopped in cleanup regardless of whether flush() already
        // stopped it (close() is idempotent) — a live loop would hold the
        // jest worker open
        const transports = (logger as unknown as { winston: { transports: Array<Record<string, unknown>> } }).winston.transports;
        const realLoki = transports[transports.length - 1] as { close: () => void };

        try {
            logger.write_error("flush-probe", "shutdown tail line");
            // Let the entry settle into the batch (winston -> transport ->
            // batcher is synchronous, but give the event loop a tick so no
            // timing assumption hides in the assertion)
            await new Promise((resolve) => { setTimeout(resolve, 50); });

            await logger.flush(2000);

            // The batch reached the server before the bounded flush returned
            expect(receivedSends).toBeGreaterThanOrEqual(1);
            // A delivered tail is not a flush timeout
            const output = await register.metrics();
            expect(output).toMatch(/^pinger_loki_flush_timeouts_total 0$/m);
        } finally {
            // Stop the Batcher's batch loop (idempotent if flush()'s
            // close() already stopped it) and close the server — without
            // this the live batch timer holds the jest worker open
            realLoki.close();
            await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
        }
    });

    it("does not count a flush that completes within the bound", async () => {
        const logger = new Logger(makeConfig());

        // No Loki transport: flush resolves immediately
        await logger.flush(50);

        const output = await register.metrics();
        expect(output).toMatch(/^pinger_loki_flush_timeouts_total 0$/m);
    });
});
