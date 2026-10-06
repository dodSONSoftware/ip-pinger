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
import { convert_from_log_level_enum_to_string, elapsed_time, get_timestamp } from "./systemFunctions";

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
            transports.push(
                new LokiTransport({
                    host: lokiCfg.url,
                    labels: { app: "ip-pinger", env: "production" },
                    format: winston.format.combine(
                        winston.format.timestamp(),
                        winston.format.json()
                    ),
                }) as unknown as Transport
            );
        }

        this.winston = winston.createLogger({
            level: LOG_LEVEL_MAP[this.globalLogLevelValue],
            levels: winston.config.npm.levels,
            transports,
            exitOnError: false,
        });
    }

    // ********
    // ******** private properties

    private readonly globalLogLevelValue: LogLevel = LogLevel.None;
    private readonly globalLogLevelName: string = "";
    private readonly winston: winston.Logger;

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

    // ********
    // ******** STATIC functions

    static write_local_log(log_level: LogLevel, originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        // create header
        let header = "";
        if (elapsed_time_start_date === null) {
            header = `[${get_timestamp(false)}][${elapsed_time(new Date(Date.now()))}][${convert_from_log_level_enum_to_string(log_level)}][${originator}]`;
        } else {
            header = `[${get_timestamp(false)}][${elapsed_time(elapsed_time_start_date)}][${convert_from_log_level_enum_to_string(log_level)}][${originator}]`;
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
