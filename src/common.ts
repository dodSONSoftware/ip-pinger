/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type { IConfig, ILogger, LogLevels } from "./interfaces";
import { LogLevel } from "./interfaces";
import { readFileSync } from "fs";
import { z } from "zod";
import { ensureError } from "./systemFunctions";
import { load } from "js-yaml";

// Config file path - must be set via CONFIG_PATH environment variable
const CONFIG_PATH_ENV = process.env["CONFIG_PATH"];
if (!CONFIG_PATH_ENV) {
    throw new Error("CONFIG_PATH environment variable is required but not set.");
}
const CONFIG_PATH: string = CONFIG_PATH_ENV;

export function getConfigPath(): string {
    return CONFIG_PATH;
}

/* ---------- Schema ---------- */
const ipRegex = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const DeviceSchema = z.object({
    source: z.string(),
    ipAddress: z.string().regex(ipRegex, "Invalid IP address"),
    deviceType: z.enum(["sensor", "controller", "kiosk"]),
});

const ConfigSchema = z.object({
    logLevel: z.enum(["debug", "info", "warn", "error"] as const),
    alwaysLogErrors: z.boolean(),
    apiPort: z.number().int().positive(),
    intervalSecs: z.number().int().positive(),
    devices: z.array(DeviceSchema),
});

/* ---------- Validation function ---------- */
export type Device = z.infer<typeof DeviceSchema>;
export type Config = z.infer<typeof ConfigSchema> & { logLevel: LogLevels };

/**
 * Validates YAML configuration string against the schema.
 * @param yaml - Raw YAML configuration string
 */
export function validateConfig(yaml: string): { ok: true; data: Config } | { ok: false; errors: string[] } {
    let parsed: unknown;
    try {
        parsed = load(yaml);
    } catch (e) {
        return { ok: false, errors: ["Invalid YAML format."] };
    }

    return validateParsedConfig(parsed as Record<string, unknown>);
}

/**
 * Loads configuration from the specified CONFIG_PATH file.
 * @param logger - Optional logger for error reporting
 */
/**
 * A no-op logger implementation for cases where logging is not needed
 */
export class NoOpLogger implements ILogger {
    global_log_level(): LogLevel {
        return LogLevel.None;
    }
    global_log_level_string(): string {
        return "None";
    }
    write_info(_originator: string, _message: string, _start_date?: Date | null | undefined): void { }
    write_warn(_originator: string, _message: string, _start_date?: Date | null | undefined): void { }
    write_error(_originator: string, _message: string, _start_date?: Date | null | undefined): void { }
    write_debug(_originator: string, _message: string, _start_date?: Date | null | undefined): void { }
}

export function loadConfig(logger?: ILogger): [IConfig, string] {
    // Use no-op logger if none provided (e.g., during initial bootstrap)
    const effectiveLogger = logger || new NoOpLogger();

    try {
        // read the file (synchronously for simplicity)
        const rawText = readFileSync(CONFIG_PATH, "utf-8");

        // parse the YAML – this gives a plain object
        const data = load(rawText) as Record<string, unknown>;

        // validate using the pre-parsed data
        const validation = validateParsedConfig(data);
        if (!validation.ok) {
            // invalid yaml
            throw new Error(`Invalid configuration: ${validation.errors.join("; ")}`);
        }

        // return the typed config object (now uses camelCase directly)
        return [validation.data as IConfig, rawText];
    } catch (err) {
        const error = ensureError(err);
        effectiveLogger.write_error("common::loadConfig()", `Error loading configuration: ${error.message}`);
        throw error;
    }
}

/**
 * Validates parsed configuration data against the schema.
 * @param data - Parsed configuration data (already loaded from YAML)
 */
export function validateParsedConfig(data: Record<string, unknown>): { ok: true; data: Config } | { ok: false; errors: string[] } {
    const result = ConfigSchema.safeParse(data);
    if (result.success) {
        return { ok: true, data: result.data };
    }

    // Collect readable error messages with full paths
    const errors = result.error.issues.map((err) => {
        const path = err.path.length ? ` (${err.path.join(".")})` : "";
        return `${err.message}${path}`.trim();
    });

    return { ok: false, errors };
}
