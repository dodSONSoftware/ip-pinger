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
}

export interface IConfig {
    log_level: string;
    always_log_errors: boolean;
    prometheus_port: number;
    interval_secs: number;
    devices: IDevice[];
}

export interface IDevice {
    source: string;
    ip_address: string;
    device_type: string;
}
