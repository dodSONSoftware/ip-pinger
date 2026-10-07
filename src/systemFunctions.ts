/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import type { ILogger } from "./interfaces";
import { LogLevel } from "./interfaces";

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
    } catch { }

    // return new error
    return new Error(result);
}

// **** file functions

/**
 * Writes content to a file with all-or-nothing persistence semantics.
 *
 * The complete new content is first written to a temporary file in the
 * same directory, then atomically renamed over the target. The visible
 * target therefore always contains either the complete previous content
 * or the complete new content — a failed write can never truncate the
 * live file mid-write.
 */
export function write_file(filename: string, content: string, logger?: ILogger): { success: boolean; error?: string } {
    // Same directory as the target so the rename stays on one filesystem
    const temporaryFilename = `${filename}.tmp`;
    try {
        fs.writeFileSync(temporaryFilename, content);
        fs.renameSync(temporaryFilename, filename);
        return { success: true };
    } catch (error) {
        // Best-effort cleanup of the temporary file. A cleanup failure must
        // not replace or hide the original write failure.
        try {
            if (fs.existsSync(temporaryFilename)) {
                fs.unlinkSync(temporaryFilename);
            }
        } catch { }

        const err = ensureError(error);
        const errorMsg = `Failed to write file "${filename}": ${err.message}`;
        logger?.write_error("systemFunctions.write_file", errorMsg);
        return { success: false, error: errorMsg };
    }
}

export function read_file(filename: string, logger?: ILogger): string | null {
    try {
        const buffer = fs.readFileSync(filename, "utf8");
        return buffer.toString();
    } catch (error) {
        const err = ensureError(error);
        logger?.write_error("systemFunctions.read_file", `Failed to read file "${filename}": ${err.message}`);
        return null;
    }
}

export function read_file_json(filename: string, logger?: ILogger): Map<string, unknown> | null {
    try {
        const data = read_file(filename, logger);
        if (data != null) {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            return new Map<string, unknown>(Object.entries(parsed));
        }
        return null;
    } catch (error) {
        const err = ensureError(error);
        logger?.write_error("systemFunctions.read_file_json", `Failed to parse JSON from "${filename}": ${err.message}`);
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
        return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, delayMS));
}

export function sleep_from_start(delayMS: number, start: Date): Promise<void> {
    const elapsed = new Date().getTime() - start.getTime();
    const remaining = delayMS - elapsed;
    if (remaining <= 0) {
        return Promise.resolve(); // Already past the deadline
    }
    return sleep(remaining);
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
