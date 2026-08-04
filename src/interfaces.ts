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

    write_info(originator: string, message: string, start_date?: Date): void {
        if (this.logLevel <= LogLevel.Info) {
            console.log(`[INFO][${originator}] ${message}`);
        }
    }

    write_warn(originator: string, message: string, start_date?: Date): void {
        if (this.logLevel <= LogLevel.Warn) {
            console.warn(`[WARN][${originator}] ${message}`);
        }
    }

    write_error(originator: string, message: string, start_date?: Date): void {
        if (this.logLevel <= LogLevel.Error) {
            console.error(`[ERROR][${originator}] ${message}`);
        }
    }

    write_debug(originator: string, message: string, start_date?: Date): void {
        if (this.logLevel <= LogLevel.Debug) {
            console.debug(`[DEBUG][${originator}] ${message}`);
        }
    }
}

// **** Pinger

export interface IPinger {
    run(): Promise<void>;
    ping_device(ip_address: string): Promise<[boolean, number]>;
    updateConfig(config: IConfig, config_str: string): void;
    rebuildGauges(): void;
}


export type LogLevels = "debug" | "info" | "warn" | "error";

export interface IConfig {
    [key: string]: unknown;
    logLevel: LogLevels;
    alwaysLogErrors: boolean;
    apiPort: number;
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
