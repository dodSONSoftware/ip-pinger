/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import * as sysFunc from "./systemFunctions";
import type { IConfig, ILogger} from "./interfaces";
import { LogLevel } from "./interfaces";

// TODO: ----------------
// TODO: reconfigure the logs to look better ( consider using json logs )
// TODO:
// TODO: consider adding a 'log_path' configuration item and writing logs to a file instead of [ stdOut ]
// TODO: ---- this will require the handling of truncating the file periodically
// TODO:   OR
// TODO: learn how to write logs directly to LOKI

export class Logger implements ILogger {
    // ********
    // ******** ctor

    constructor(config: IConfig) {
        // get global log level
        this.globalLogLevelValue = sysFunc.convert_from_log_level_string_to_enum(config.logLevel);
        this.globalLogLevelName = sysFunc.convert_from_log_level_enum_to_string(this.globalLogLevelValue);
        this.globalAlwaysLogErrors = Boolean(config.alwaysLogErrors);
    }

    // ********
    // ******** private properties

    private readonly globalLogLevelValue: LogLevel = LogLevel.None;
    private readonly globalLogLevelName: string = "";
    private readonly globalAlwaysLogErrors: boolean = false;

    // ********
    // ******** ILogger functions

    global_log_level(): LogLevel {
        return this.globalLogLevelValue;
    }

    global_log_level_string(): string {
        return this.globalLogLevelName;
    }

    write_debug(originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        this._write_local_log(LogLevel.Debug, originator, message, elapsed_time_start_date);
    }

    write_info(originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        this._write_local_log(LogLevel.Info, originator, message, elapsed_time_start_date);
    }

    write_warn(originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        this._write_local_log(LogLevel.Warn, originator, message, elapsed_time_start_date);
    }

    write_error(originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        this._write_local_log(LogLevel.Error, originator, message, elapsed_time_start_date);
    }

    // ********
    // ******** STATIC functions

    static write_local_log(log_level: LogLevel, originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        // create header
        let header = "";
        if (elapsed_time_start_date === null) {
            header = `[${sysFunc.get_timestamp(false)}][${sysFunc.elapsed_time(new Date(Date.now()))}][${sysFunc.convert_from_log_level_enum_to_string(log_level)}][${originator}]`;
        } else {
            header = `[${sysFunc.get_timestamp(false)}][${sysFunc.elapsed_time(elapsed_time_start_date)}][${sysFunc.convert_from_log_level_enum_to_string(log_level)}][${originator}]`;
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

    // ********
    // ******** PRIVATE logging functions

    private _canLog(logLevel: LogLevel): boolean {
        // check for an auto-error
        if (this.globalAlwaysLogErrors && logLevel === LogLevel.Error) {
            return true;
        }

        // check for global log level of None
        if (this.global_log_level() === LogLevel.None) {
            return false;
        }

        // check given log level
        if (logLevel.valueOf() <= this.global_log_level().valueOf()) {
            return true;
        }

        // default
        return false;
    }

    private _write_local_log(log_level: LogLevel, originator: string, message: string, elapsed_time_start_date: Date | null = null): void {
        // check
        if (this._canLog(log_level)) {
            Logger.write_local_log(log_level, originator, message, elapsed_time_start_date);
        }
    }
}
