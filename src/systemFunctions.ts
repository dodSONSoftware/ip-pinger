import fs from "fs";
import * as childProc from "child_process";
import { LogLevel } from "./interfaces";

// **** environment variables functions

export function getEnvironmentVariable(name: string, defaultValue: any): any {
    return process.env[name]?.valueOf() ?? defaultValue;
}

// **** error functions

export function ensureError(value: unknown): Error {
    // check for undefined
    if (value === undefined) return Error("<<< Error is undefined >>>");

    // check for error
    if (value instanceof Error) return value;

    // convert to json string
    let result = "Unknown Error: error value cannot be converted to a json string.";
    try {
        result = JSON.stringify(value);
    } catch {}

    // return new error
    return new Error(result);
}

// **** file functions

export function write_file(filename: string, content: string): boolean {
    try {
        fs.writeFileSync(filename, content);
        return true;
    } catch (error) {
        // TODO: log error
        return false;
    }
}

export function read_file(filename: string): string | null {
    try {
        const buffer = fs.readFileSync(filename, "utf8");
        return buffer.toString();
    } catch (error) {
        // TODO: log error
        return null;
    }
}

export function read_file_json(filename: string): Map<string, any> | null {
    try {
        const data = read_file(filename);
        if (data != null) {
            return new Map<string, any>(Object.entries(JSON.parse(data)));
        }
        return null;
    } catch (error) {
        // TODO: log error
        return null;
    }
}

// ******** enum conversion functions

export function convert_from_log_level_string_to_enum(logLevelString: string): LogLevel {
    let value = LogLevel.None;

    // TODO: convert this to a if.elif.elif.... and use the [ STRING.startswith() ] function

    switch (logLevelString.toLowerCase()) {
        case "error":
            value = LogLevel.Error;
            break;
        case "warn":
            value = LogLevel.Warn;
            break;
        case "info":
            value = LogLevel.Info;
            break;
        case "debug":
            value = LogLevel.Debug;
            break;
    }
    return value;
}

export function convert_from_log_level_enum_to_string(log_level: LogLevel): string {
    let value = "None";

    switch (log_level) {
        case LogLevel.Error:
            value = "Error";
            break;
        case LogLevel.Warn:
            value = "Warn";
            break;
        case LogLevel.Info:
            value = "Info";
            break;
        case LogLevel.Debug:
            value = "Debug";
            break;
    }
    return value;
}

// **** sleep functions

export function sleep(delayMS: number): Promise<void> {
    if (delayMS === 0) {
        return new Promise(() => {});
    }
    return new Promise((resolve) => setTimeout(resolve, delayMS));
}

export function sleep_from_start(delayMS: number, start: Date): Promise<void> {
    return sleep(delayMS - (new Date().getTime() - start.getTime()));
}

// **** general functions

export function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// **** time-related functions

export function get_timestamp_iso(): string {
    return new Date().toISOString().slice(0, -1);
}

export function get_timestamp(include_ms: boolean): string {
    // init
    const dt = new Date();

    // get date and time components
    const year = String(dt.getFullYear());
    const month = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    const h = String(dt.getHours()).padStart(2, "0");
    const m = String(dt.getMinutes()).padStart(2, "0");
    const s = String(dt.getSeconds()).padStart(2, "0");
    const ms = String(dt.getMilliseconds()).padStart(3, "0");

    // get the timestamp
    let dude = `${year}-${month}-${day} ${h}:${m}:${s}`;

    // check if including milliseconds
    if (include_ms) {
        dude = `${dude}.${ms}`;
    }

    // return results
    return dude;
}

/**
 * @param start_time - Populate with a Date
 * @returns Returns a string formatted to show the elapsed time
 */
export function elapsed_time(start_time: Date | undefined): string {
    let start_time_value = Date.now();

    if (start_time !== undefined) {
        start_time_value = start_time.valueOf();
    }

    return formatElapsedTime(Date.now() - start_time_value);
}

export function elapsed_time_seconds(start_date: Date): number {
    return (Date.now() - start_date.valueOf()) / 1000;
}

export function formatElapsedTime(ms: number): string {
    // Calculate hours, minutes, seconds, and remaining milliseconds
    const hours = Math.floor(ms / 3600000);
    ms %= 3600000; // Remaining milliseconds after hours
    const minutes = Math.floor(ms / 60000);
    ms %= 60000; // Remaining milliseconds after minutes
    const seconds = Math.floor(ms / 1000);
    const milliseconds = ms % 1000; // Remaining milliseconds

    // Format the result
    const hours_str = hours.toString().padStart(2, "0");
    const minutes_str = minutes.toString().padStart(2, "0");
    const seconds_str = seconds.toString().padStart(2, "0");
    const ms_str = milliseconds.toString().padStart(3, "0");
    return `${hours_str}:${minutes_str}:${seconds_str}.${ms_str}`;
}

// **** process functions

export async function executeCommandLine_Command(cmd: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        childProc.exec(cmd, (error, stdout, stderr) => {
            if (error) {
                const msg = `Error executing script: ${error.message}`;
                reject(new Error(msg));
            }
            if (stderr) {
                const msg = `Script error output: ${stderr}`;
                reject(new Error(msg));
            }
            resolve(stdout); // Resolve with the standard output
        });
    });
}
