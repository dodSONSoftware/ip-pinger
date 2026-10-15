/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import winston from "winston";
import type Transport from "winston-transport";
import LokiTransport from "winston-loki";
import type { TransformableInfo } from "logform";
import { Counter } from "prom-client";
import type { IConfig, ILogger } from "./interfaces";
import { LogLevel } from "./interfaces";
import { getLokiConfig } from "./common";
import { convert_from_log_level_enum_to_string, elapsed_time, ensureError, get_timestamp } from "./systemFunctions";

// While a Loki outage is ongoing the batcher keeps retrying (after the
// first failure the library's circuit breaker drops to one attempt per
// minute), and every failed attempt fires onConnectionError. The warn
// below fires on the first failure and then at most once per this
// interval, carrying how many failed sends it subsumes.
const LOKI_WARN_INTERVAL_MS = 5 * 60 * 1000;

// Map our LogLevel enum to Winston level priority
const LOG_LEVEL_MAP: Record<LogLevel, string> = {
    [LogLevel.None]: "silent",
    [LogLevel.Error]: "error",
    [LogLevel.Warn]: "warn",
    [LogLevel.Info]: "info",
    [LogLevel.Debug]: "debug",
};

// Max log entries winston-loki may hold unsent in memory. Its Batcher keeps
// the whole pending batch resident and requeues it in full after every failed
// send (clearOnError defaults to false), so during a prolonged Loki outage the
// batch loop keeps retrying (one attempt per minute once its circuit breaker
// trips) and each failure requeues an ever-larger batch — the in-memory
// footprint grows without bound for the lifetime of the outage. The library
// exposes no cap and its `timeout` option is inert (never wired to the
// underlying request), so nothing upstream stops the growth. BoundedLoki
// transport adds the cap: after each write it trims the pending batch to the
// newest MAX_PENDING_LOKI_ENTRIES entries, dropping the oldest, so a long
// outage keeps a bounded, recent tail of logs (and on recovery the last set of
// logs is what gets delivered) instead of an ever-growing backlog.
export const MAX_PENDING_LOKI_ENTRIES = 10000;

// A pending entry's timestamp, as a comparable millisecond value, whatever
// wire format winston-loki is using. With the protobuf transport (the
// default when snappy is available) pushLogEntry rewrites each entry to
// { timestamp: { seconds, nanos }, line }; with the JSON fallback it keeps
// { ts, line, rest }. The FIFO drop below needs one comparable value either
// way.
function entryTimestampMs(entry: { ts?: number; timestamp?: { seconds: number; nanos?: number } }): number {
    if (typeof entry.ts === "number") {
        return entry.ts;
    }
    const t = entry.timestamp;
    if (t && typeof t.seconds === "number") {
        return t.seconds * 1000 + Math.floor((t.nanos ?? 0) / 1e6);
    }
    // No timestamp at all: treat as oldest so it is dropped first.
    return 0;
}

// The plain LokiTransport's constructor parameter type (the option interface
// is not exported by winston-loki, so it is recovered from the constructor).
type LokiTransportOptions = ConstructorParameters<typeof LokiTransport>[0];

// Exported (with its cap constant) so the FIFO trim is directly testable
// without spinning up a full Logger and Loki server.
export class BoundedLokiTransport extends LokiTransport {
    // Invoked with the number of entries dropped by the trim that just ran,
    // only when at least one was dropped. The Logger wires this to
    // pinger_loki_dropped_entries_total so the drops are observable in
    // /metrics. Optional: a test that constructs the transport directly can
    // omit it.
    private readonly onDrop?: (dropped: number) => void;

    constructor(options: LokiTransportOptions & { onDrop?: (dropped: number) => void }) {
        super(options);
        this.onDrop = options.onDrop;
    }

    // winston-loki's log() pushes the entry into the batch synchronously
    // (batching is on), so trimming immediately after super.log() sees the
    // new entry and caps the batch to the newest MAX_PENDING_LOKI_ENTRIES.
    log(info: TransformableInfo, callback: () => void): void {
        // The base log() is optional in winston-loki's type declaration but
        // always present at runtime; optional-call keeps the type checker
        // happy. It pushes the entry into the batch synchronously, so the
        // trim below sees the new entry and caps the batch.
        super.log?.(info, callback);
        this.trimPendingBatch();
    }

    // Drop the oldest pending entries until the batch holds at most
    // MAX_PENDING_LOKI_ENTRIES. The batch is an array of streams (one per
    // distinct label set; here, effectively one per log level, since the
    // static labels are fixed and only the per-entry level varies). Entries
    // within a stream are chronological, oldest first — new entries are
    // appended and failed sends requeue their snapshot at the front — so each
    // stream's front is its oldest. Drop from the front of the stream whose
    // front is oldest first, i.e. a FIFO that discards the globally oldest.
    private trimPendingBatch(): void {
        const streams = (this as unknown as {
            batcher?: { batch?: { streams: Array<{ entries: Array<{ ts?: number; timestamp?: { seconds: number; nanos?: number } }> }> } };
        }).batcher?.batch?.streams;
        if (!streams) {
            return;
        }
        let total = 0;
        for (const stream of streams) {
            total += stream.entries.length;
        }
        let excess = total - MAX_PENDING_LOKI_ENTRIES;
        let dropped = 0;
        while (excess > 0) {
            let oldest = -1;
            let oldestTs = Infinity;
            for (let i = 0; i < streams.length; i++) {
                const front = streams[i].entries[0];
                if (!front) {
                    continue;
                }
                const ts = entryTimestampMs(front);
                if (ts < oldestTs) {
                    oldestTs = ts;
                    oldest = i;
                }
            }
            if (oldest === -1) {
                break;
            }
            streams[oldest].entries.shift();
            excess--;
            dropped++;
        }
        if (dropped > 0) {
            this.onDrop?.(dropped);
        }
    }
}

/**
 * Structured logger backed by Winston with optional Loki remote transport.
 * Implements the ILogger interface so all existing callers work unchanged.
 */
export class Logger implements ILogger {
    // ********
    // ******** ctor

    constructor(config: IConfig) {
        this.globalLogLevelValue = config.logLevel === "debug" ? LogLevel.Debug
            : config.logLevel === "info" ? LogLevel.Info
                : config.logLevel === "warn" ? LogLevel.Warn
                    : LogLevel.Error;

        // Application-level metrics for the Loki transport (unlabeled): a
        // remote log sink that is silently dropping entries is the same
        // class of problem this service monitors for in devices, so it is
        // visible in /metrics the same way. Both stay at 0 while the
        // transport is disabled.
        this.lokiSendFailuresTotal = new Counter({
            name: `pinger_loki_send_failures_total`,
            help: "Failed sends to the Loki transport (each failed batched POST).",
        });
        this.lokiFlushTimeoutsTotal = new Counter({
            name: `pinger_loki_flush_timeouts_total`,
            help: "Bounded flush() calls that timed out before Loki acknowledged the queued entries.",
        });
        this.lokiDroppedEntriesTotal = new Counter({
            name: `pinger_loki_dropped_entries_total`,
            help: "Log entries dropped from the Loki pending batch because it exceeded the FIFO cap (oldest entries discarded when full).",
        });

        // Build Winston logger with configured transports
        const transports: Transport[] = [
            // Console transport — human-readable, mirrors previous format
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.errors({ stack: true }),
                    winston.format.printf(({ timestamp, level, message, originator, elapsed }) => {
                        const header = `[${timestamp}][${elapsed ?? "00:00:00.000"}][${level.toUpperCase().padEnd(5, " ")}][${originator}]`;
                        return `${header} ${message}`;
                    })
                ),
            }) as Transport,
        ];

        // Add Loki transport when configured and enabled
        const lokiCfg = getLokiConfig(config);
        if (lokiCfg.enabled && lokiCfg.url) {
            // No `level` of its own — the transport inherits the logger
            // level set below, so logLevel applies to Loki output too.
            // Raising it reduces the Loki write rate (entries below the
            // level never reach any transport); errors always pass at any
            // valid configured level.
            //
            // BoundedLokiTransport (not the plain LokiTransport) caps the
            // pending in-memory batch to the newest MAX_PENDING_LOKI_ENTRIES
            // entries, so a prolonged Loki outage cannot grow it without
            // bound (see the class doc).
            transports.push(
                new BoundedLokiTransport({
                    host: lokiCfg.url,
                    labels: { app: "ip-pinger", env: "production" },
                    // The library stays silent on connection errors (its
                    // batch loop swallows the failure and requeues the
                    // batch), so without this hook an outage is invisible
                    onConnectionError: (error: unknown): void => {
                        this.onLokiConnectionError(error);
                    },
                    // Surface FIFO drops in /metrics: the trim reports how
                    // many entries it discarded so a long outage's silent
                    // loss of the oldest logs is observable.
                    onDrop: (dropped: number): void => {
                        this.lokiDroppedEntriesTotal.inc(dropped);
                    },
                    format: winston.format.combine(
                        winston.format.timestamp(),
                        winston.format.json()
                    ),
                }) as unknown as Transport
            );
        }

        this.winston = winston.createLogger({
            // The configured logLevel gates ALL transports (console and
            // Loki): entries below it are filtered here, before reaching
            // any transport, so both sinks respect the same verbosity.
            level: LOG_LEVEL_MAP[this.globalLogLevelValue],
            levels: winston.config.npm.levels,
            transports,
            exitOnError: false,
        });

        // Log the logging setup itself: whether Loki is active is
        // otherwise invisible at boot — a disabled or misconfigured
        // transport produces no other signal, and entries would silently
        // never arrive in Loki.
        if (lokiCfg.enabled && lokiCfg.url) {
            this.write_info("Logger.ctor", `Loki transport active: ${lokiCfg.url}`);
        } else if (lokiCfg.enabled) {
            // Unreachable through validated configuration (the schema
            // requires lokiUrl when lokiEnabled is true) — defensive for
            // a Logger constructed with a raw, unvalidated config.
            this.write_warn("Logger.ctor", `Loki transport disabled: lokiEnabled is true but lokiUrl is missing`);
        } else {
            this.write_info("Logger.ctor", `Loki transport disabled (lokiEnabled is false)`);
        }
    }

    // ********
    // ******** private properties

    private readonly globalLogLevelValue: LogLevel = LogLevel.None;
    private readonly winston: winston.Logger;
    private readonly lokiSendFailuresTotal: Counter;
    private readonly lokiFlushTimeoutsTotal: Counter;
    private readonly lokiDroppedEntriesTotal: Counter;
    // Rate-limiter state for the Loki connection-failure warn (see
    // onLokiConnectionError): total failed sends since construction,
    // the total at the last warn, and the last warn's timestamp.
    private lokiFailureCount = 0;
    private lokiFailuresAtLastWarn = 0;
    private lokiLastWarnAt = 0;

    // ********
    // ******** ILogger functions

    write_debug(
        originator: string,
        message: string,
        elapsed_time_start_date: Date | null = null,
    ): void {
        const elapsed = elapsed_time_start_date
            ? elapsed_time(elapsed_time_start_date)
            : "00:00:00.000";
        this.winston.log({
            level: "debug",
            message,
            originator,
            elapsed,
        });
    }

    write_info(
        originator: string,
        message: string,
        elapsed_time_start_date: Date | null = null,
    ): void {
        const elapsed = elapsed_time_start_date
            ? elapsed_time(elapsed_time_start_date)
            : "00:00:00.000";
        this.winston.log({
            level: "info",
            message,
            originator,
            elapsed,
        });
    }

    write_warn(
        originator: string,
        message: string,
        elapsed_time_start_date: Date | null = null,
    ): void {
        const elapsed = elapsed_time_start_date
            ? elapsed_time(elapsed_time_start_date)
            : "00:00:00.000";
        this.winston.log({
            level: "warn",
            message,
            originator,
            elapsed,
        });
    }

    write_error(
        originator: string,
        message: string,
        elapsed_time_start_date: Date | null = null,
    ): void {
        const elapsed = elapsed_time_start_date
            ? elapsed_time(elapsed_time_start_date)
            : "00:00:00.000";
        this.winston.log({
            level: "error",
            message,
            originator,
            elapsed,
        });
    }

    /**
     * winston-loki hook for every failed POST to Loki. The first failure
     * warns immediately; while the outage continues, at most one further
     * warn per LOKI_WARN_INTERVAL_MS, carrying how many failed sends it
     * subsumes (the circuit breaker already limits retries to one per
     * minute after the first failure, so a long outage produces one warn
     * per five minutes, not one per retry). The warn is routed through
     * winston, so it reaches the console immediately and is queued for
     * Loki — when the connection recovers, the record of the outage is
     * delivered there as well.
     */
    private onLokiConnectionError(error: unknown): void {
        this.lokiFailureCount++;
        // Count every failed send: the warn below is rate-limited, but the
        // counter must not be — a long outage is one warn per five minutes
        // and potentially hundreds of failed batches
        this.lokiSendFailuresTotal.inc();
        const now = Date.now();
        if (this.lokiFailureCount > 1 && now - this.lokiLastWarnAt < LOKI_WARN_INTERVAL_MS) {
            return;
        }
        const suppressed = this.lokiFailureCount - this.lokiFailuresAtLastWarn - 1;
        this.lokiFailuresAtLastWarn = this.lokiFailureCount;
        this.lokiLastWarnAt = now;
        const err = ensureError(error);
        const detail = suppressed > 0
            ? `Loki request failed: ${err.message} (${suppressed} earlier failure(s) not repeated)`
            : `Loki request failed: ${err.message}`;
        this.write_warn("Logger.loki", detail);
    }

    /**
     * Sends every entry queued in the Loki transport right now, and waits
     * (bounded) for that send attempt to complete.
     *
     * The send is triggered explicitly: winston-loki's own flush()
     * (waitFlushed) only waits passively for the batch loop's next
     * SCHEDULED send — the 5 s default interval — and never starts one.
     * The bounded wait below is shorter than that interval, so a plain
     * wait expires before the tick whenever it is more than timeoutMs
     * away, and the queued tail — which on a shutdown includes the
     * shutdown lines themselves, logged microseconds earlier — dies in
     * the in-memory batch with process.exit() even when Loki is healthy.
     * The transport's close() is the trigger: it stops the batch loop and
     * performs an immediate final send, so a reachable Loki acknowledges
     * the tail in milliseconds, and an unreachable one is still bounded
     * by timeoutMs.
     *
     * close() permanently stops the batch loop, which is safe here because
     * flush() is only ever called from process-exit paths (the graceful
     * signal shutdown, the fatal ping-engine termination, and the terminal
     * error boundary).
     *
     * Resolves immediately when no Loki transport is configured. The wait
     * ends when the send ATTEMPT completes, success or failure: a refused
     * send requeues its entries (lost if the process exits next) and is
     * counted in pinger_loki_send_failures_total, not in the
     * flush-timeout counter.
     */
    async flush(timeoutMs: number): Promise<void> {
        // Only the Loki transport implements an async flush(); the console
        // transport does not. Duck-typed on purpose so this keeps working if
        // the transport implementation is swapped.
        const loki = this.winston.transports.find(
            (t): t is Transport & { flush: () => Promise<unknown> } =>
                typeof (t as unknown as { flush?: unknown }).flush === "function"
        );
        if (!loki) {
            return;
        }
        // Trigger the immediate final send (see the method comment).
        // Optional on purpose: a swapped-in transport without close() still
        // gets the bounded wait below.
        (loki as unknown as { close?: () => unknown }).close?.();
        let timer: NodeJS.Timeout | undefined;
        try {
            const outcome = await Promise.race([
                loki.flush().then((): "flushed" => "flushed").catch((): "failed" => "failed"),
                new Promise<"timeout">((resolve) => {
                    timer = setTimeout(() => resolve("timeout"), timeoutMs);
                }),
            ]);
            // The bounded wait exists so an unreachable Loki cannot stall
            // the caller (the terminal error boundary must exit even when
            // Loki is down) — when the timeout wins, say so, because the
            // queued entries may never have been delivered.
            if (outcome === "timeout") {
                // Only a timeout is counted: the batched sends whose
                // failures it subsumes are already counted individually in
                // pinger_loki_send_failures_total
                this.lokiFlushTimeoutsTotal.inc();
                this.write_warn("Logger.flush", `Loki flush timed out after ${timeoutMs}ms; queued log entries may not have reached Loki.`);
            }
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    // ********
    // ******** STATIC functions

    static write_local_log(log_level: LogLevel, originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        // No explicit start means "since the process started": the callers
        // that omit it (the boot line) predate the service's own start
        // timestamps, and elapsed_time(now) would print 00:00:00.000 on
        // every such line.
        const start = elapsed_time_start_date ?? new Date(Date.now() - process.uptime() * 1000);
        // create header
        const header = `[${get_timestamp()}][${elapsed_time(start)}][${convert_from_log_level_enum_to_string(log_level)}][${originator}]`;

        // create message
        const msg = `${header} ${message}`;

        // check for error
        if (log_level === LogLevel.Error) {
            // write message to stdErr
            console.error(msg);
        } else {
            // write message to stdOut
            console.log(msg);
        }
    }

}
