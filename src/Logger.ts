/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import winston from "winston";
import type Transport from "winston-transport";
import LokiTransport from "winston-loki";
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

        this.globalLogLevelName = config.logLevel;

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
    private readonly globalLogLevelName: string = "";
    private readonly winston: winston.Logger;
    // Rate-limiter state for the Loki connection-failure warn (see
    // onLokiConnectionError): total failed sends since construction,
    // the total at the last warn, and the last warn's timestamp.
    private lokiFailureCount = 0;
    private lokiFailuresAtLastWarn = 0;
    private lokiLastWarnAt = 0;

    // ********
    // ******** ILogger functions

    global_log_level(): LogLevel {
        return this.globalLogLevelValue;
    }

    global_log_level_string(): string {
        return this.globalLogLevelName;
    }

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
     * Waits for the Loki transport to confirm receipt of every entry queued
     * so far (its async flush() resolves only after Loki acknowledges).
     * Resolves immediately when no Loki transport is configured. Bounded by
     * timeoutMs so an unreachable Loki cannot stall the caller — e.g. the
     * terminal error boundary, which must exit even when Loki is down.
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
        // create header
        let header = "";
        if (elapsed_time_start_date === null) {
            header = `[${get_timestamp()}][${elapsed_time(new Date(Date.now()))}][${convert_from_log_level_enum_to_string(log_level)}][${originator}]`;
        } else {
            header = `[${get_timestamp()}][${elapsed_time(elapsed_time_start_date)}][${convert_from_log_level_enum_to_string(log_level)}][${originator}]`;
        }

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
