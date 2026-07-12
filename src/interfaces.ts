/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

// **** Logger

export const enum LogLevel {
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

// **** Pinger

export interface IPinger {
    run(): Promise<void>;
    //ping_device(ip_address: string): [boolean, number]
    ping_device(ip_address: string): Promise<[boolean, number]>;
    updateConfig(config: IConfig, config_str: string): void;
    rebuildGauges(): void;
}

export interface IPingResults {
    source: string;
    ip_address: string;
    is_alive: boolean;
    roundtrip_ms: number;
}

export interface IConfig {
    log_level: string;
    always_log_errors: boolean;
    prometheus_port: number;
    api_port: number;
    interval_secs: number;
    devices: IDevice[];
}

export interface IDevice {
    source: string;
    ip_address: string;
    device_type: string;
}
