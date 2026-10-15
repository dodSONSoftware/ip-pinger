/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { Logger, BoundedLokiTransport, MAX_PENDING_LOKI_ENTRIES } from "../../../src/Logger";
import type { TransformableInfo } from "logform";
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
        expect(output).toMatch(/^pinger_loki_dropped_entries_total 0$/m);
    });

    it("counts entries dropped by the FIFO cap in pinger_loki_dropped_entries_total", async () => {
        // A real (bounded) transport against a dead Loki: filling the batch
        // past the cap drops the oldest entries, and the Logger's onDrop hook
        // must count every one of them.
        const logger = new Logger(makeConfig({ lokiEnabled: true, lokiUrl: "http://127.0.0.1:9" }));
        const transports = (logger as unknown as { winston: { transports: Array<Record<string, unknown>> } }).winston.transports;
        const transport = transports[transports.length - 1] as unknown as BoundedLokiTransport & {
            batcher: {
                batch: { streams: Array<{ entries: unknown[] }> };
                close: () => Promise<void>;
            };
        };
        const batcher = transport.batcher;

        try {
            const total = MAX_PENDING_LOKI_ENTRIES + 5;
            for (let i = 0; i < total; i++) {
                transport.log({
                    message: `drop-${i}`,
                    [Symbol.for("level")]: "info",
                } as unknown as TransformableInfo, () => undefined);
            }

            const output = await register.metrics();
            expect(output).toMatch(/^pinger_loki_dropped_entries_total 5$/m);
        } finally {
            // Drop the batch and stop the batch loop (a live loop would hold
            // the jest worker open); close()'s final send is then a no-op
            batcher.batch.streams = [];
            await new Promise((resolve) => { setImmediate(resolve); });
            await batcher.close();
        }
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

describe("BoundedLokiTransport (FIFO pending-batch cap)", () => {
    // The transport is driven directly (not through a full Logger) so the
    // cap can be exercised at its production value without a live Loki
    // server. All entries share one label set, so they land in a single
    // stream and the FIFO drop is unambiguous.
    it("caps the pending batch to the newest MAX entries, dropping the oldest", async () => {
        const transport = new BoundedLokiTransport({
            host: "http://127.0.0.1:9",
            labels: { app: "bounded-test" },
            // No exit-hook registration in a unit test
            gracefulShutdown: false,
        });
        const batcher = (transport as unknown as {
            batcher: {
                batch: { streams: Array<{ entries: Array<{ line: string }> }> };
                close: () => Promise<void>;
            };
        }).batcher;

        try {
            const total = MAX_PENDING_LOKI_ENTRIES + 5;
            for (let i = 0; i < total; i++) {
                // Only the winston level symbol, no plain `level` key: a plain
                // key would land in winston-loki's rest object and change the
                // line format. Cast because TransformableInfo requires the
                // plain key but the transport reads only the symbol.
                transport.log({
                    message: `line-${i}`,
                    [Symbol.for("level")]: "info",
                } as unknown as TransformableInfo, () => undefined);
            }

            const lines = batcher.batch.streams.flatMap((s) => s.entries.map((e) => e.line));
            // The batch is capped at MAX entries, never above it
            expect(lines).toHaveLength(MAX_PENDING_LOKI_ENTRIES);
            // The newest entry survived (the winston-loki line format is
            // "<message> <rest>" with empty rest, hence the trailing space)
            expect(lines[lines.length - 1]).toBe(`line-${total - 1} `);
            // The oldest 5 (line-0..line-4) were dropped; the first survivor
            // is line-5 — a true FIFO that keeps the most recent logs
            expect(lines[0]).toBe(`line-5 `);
            expect(lines.some((l) => l === "line-0 ")).toBe(false);
        } finally {
            // Always stop the batch loop: a live loop (and its pending 5 s
            // timer) would hold the jest worker open even if an assertion
            // above fails. Drop the batch first so close()'s final send is a
            // no-op rather than a 10 000-entry encode + refused POST.
            batcher.batch.streams = [];
            // Let the loop's first iteration reach its wait() before close():
            // closing in the same tick as construction races ahead of that
            // wait(), so close() would sleep out the full 5 s batch interval.
            // (A production flush() runs at exit, long after construction, so
            // it is never affected by this race.)
            await new Promise((resolve) => { setImmediate(resolve); });
            await batcher.close();
        }
    });

    // Different log levels produce different label sets, so they land in
    // separate streams. The cap is on the TOTAL entry count across all
    // streams, not per stream.
    it("caps the total pending entries across multiple label streams", async () => {
        const transport = new BoundedLokiTransport({
            host: "http://127.0.0.1:9",
            labels: { app: "multi" },
            gracefulShutdown: false,
        });
        const batcher = (transport as unknown as {
            batcher: {
                batch: { streams: Array<{ entries: unknown[] }> };
                close: () => Promise<void>;
            };
        }).batcher;

        try {
            const total = MAX_PENDING_LOKI_ENTRIES + 4;
            for (let i = 0; i < total; i++) {
                const level = i % 2 === 0 ? "info" : "error";
                transport.log({
                    message: `m-${i}`,
                    [Symbol.for("level")]: level,
                } as unknown as TransformableInfo, () => undefined);
            }

            // Two streams (info and error), but the batch is capped at MAX
            // entries in total
            expect(batcher.batch.streams.length).toBe(2);
            let count = 0;
            for (const s of batcher.batch.streams) {
                count += s.entries.length;
            }
            expect(count).toBe(MAX_PENDING_LOKI_ENTRIES);
        } finally {
            batcher.batch.streams = [];
            await new Promise((resolve) => { setImmediate(resolve); });
            await batcher.close();
        }
    });
});
