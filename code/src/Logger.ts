/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import winston from "winston";
import type Transport from "winston-transport";
import LokiTransport from "winston-loki";
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
            transports.push(
                new LokiTransport({
                    host: lokiCfg.url,
                    labels: { app: "ip-pinger", env: "production" },
                    // The library stays silent on connection errors (its
                    // batch loop swallows the failure and requeues the
                    // batch), so without this hook an outage is invisible
                    onConnectionError: (error: unknown): void => {
                        this.onLokiConnectionError(error);
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
