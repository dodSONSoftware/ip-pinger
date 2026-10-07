/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

// **** Logger

export enum LogLevel {
    None = 0,
    Info,
    Warn,
    Error,
    Debug,
}

export interface ILogger {
    global_log_level(): LogLevel;
    global_log_level_string(): string;
    write_info(originator: string, message: string, start_date?: Date): void;
    write_warn(originator: string, message: string, start_date?: Date): void;
    write_error(originator: string, message: string, start_date?: Date): void;
    write_debug(originator: string, message: string, start_date?: Date): void;
}

// Severity ordering for minimum-level filtering. The LogLevel enum's numeric
// values are not ordered by severity (None=0, Info=1, Warn=2, Error=3,
// Debug=4), so comparisons must go through this explicit priority: a message
// is emitted when its priority is at most the configured level's priority.
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    [LogLevel.None]: -1,
    [LogLevel.Error]: 0,
    [LogLevel.Warn]: 1,
    [LogLevel.Info]: 2,
    [LogLevel.Debug]: 3,
};

/**
 * A minimal console-based logger for bootstrap scenarios before full config loading.
 */
export class ConsoleLogger implements ILogger {
    private readonly logLevel: LogLevel;

    constructor(minLogLevel: LogLevel = LogLevel.Info) {
        this.logLevel = minLogLevel;
    }

    global_log_level(): LogLevel {
        return this.logLevel;
    }

    global_log_level_string(): string {
        switch (this.logLevel) {
            case LogLevel.Debug: return "Debug";
            case LogLevel.Info: return "Info";
            case LogLevel.Warn: return "Warn";
            case LogLevel.Error: return "Error";
            default: return "None";
        }
    }

    /**
     * Central minimum-level decision: a message of the given severity is
     * emitted when its priority does not exceed the configured level's
     * priority. None disables everything; Debug enables every level.
     */
    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this.logLevel];
    }

    write_info(originator: string, message: string, start_date?: Date): void {
        if (this.shouldLog(LogLevel.Info)) {
            console.log(`[INFO][${originator}] ${message}`);
        }
    }

    write_warn(originator: string, message: string, start_date?: Date): void {
        if (this.shouldLog(LogLevel.Warn)) {
            console.warn(`[WARN][${originator}] ${message}`);
        }
    }

    write_error(originator: string, message: string, start_date?: Date): void {
        if (this.shouldLog(LogLevel.Error)) {
            console.error(`[ERROR][${originator}] ${message}`);
        }
    }

    write_debug(originator: string, message: string, start_date?: Date): void {
        if (this.shouldLog(LogLevel.Debug)) {
            console.debug(`[DEBUG][${originator}] ${message}`);
        }
    }
}

// **** Pinger

export interface IPinger {
    start(): Promise<void>;
    run(): Promise<void>;
    ping_device(ip_address: string): Promise<[boolean, number]>;
    updateConfig(config: IConfig, config_str: string): void;
    // False once the net-ping session has failed unexpectedly: the pinger
    // can no longer run cycles and only a process restart recovers it.
    isOperational(): boolean;
    close(): Promise<void>;
}


export type LogLevels = "debug" | "info" | "warn" | "error";

export interface IConfig {
    [key: string]: unknown;
    logLevel: LogLevels;
    intervalSecs: number;
    devices: IDevice[];
    lokiUrl?: string;
    lokiEnabled?: boolean;
}

export interface IDevice {
    source: string;
    ipAddress: string;
    deviceType: "sensor" | "server" | "kiosk";
}
