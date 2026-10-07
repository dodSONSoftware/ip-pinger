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

/**
 * Fixed HTTP API port. The Docker deployment (port publishing and health
 * checks) is bound to this port, so the listener port is an application
 * constant rather than a runtime configuration setting.
 */
export const API_PORT = 3300;

/* ---------- Schema ---------- */

const DeviceSchema = z.object({
    source: z.string(),
    ipAddress: z.ipv4("Invalid IP address"),
    deviceType: z.enum(["sensor", "server", "kiosk"]),
});

const ConfigSchema = z
    .object({
        logLevel: z.enum(["debug", "info", "warn", "error"] as const),
        intervalSecs: z.number().int().positive(),
        devices: z.array(DeviceSchema),
        lokiUrl: z.string().url().optional(),
        lokiEnabled: z.boolean().optional(),
    })
    .superRefine((config, ctx) => {
        // Enabling Loki without a URL would silently disable the remote
        // transport (the logger checks both values); reject the
        // configuration instead of letting it fail at the logger boundary.
        if (config.lokiEnabled === true && !config.lokiUrl) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["lokiUrl"],
                message: "lokiUrl is required when lokiEnabled is true",
            });
        }

        // Reject exact duplicate device identities (ipAddress + source +
        // deviceType). Two identical entries would publish the same
        // Prometheus series and be pinged twice, double-counting the
        // aggregate up/down gauges, latency histogram, and error totals
        // for one logical device. Sharing an IP address across different
        // sources or device types is still valid — those are distinct
        // series.
        const seen = new Set<string>();
        config.devices.forEach((device, index) => {
            const key = JSON.stringify([device.ipAddress, device.source, device.deviceType]);
            if (seen.has(key)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["devices", index],
                    message: `Duplicate device definition: source="${device.source}", ipAddress="${device.ipAddress}", deviceType="${device.deviceType}"`,
                });
                return;
            }
            seen.add(key);
        });
    });

/* ---------- Validation function ---------- */
export type Device = z.infer<typeof DeviceSchema>;
export type Config = z.infer<typeof ConfigSchema> & { logLevel: LogLevels };

/* ---------- Restart-required settings ---------- */

// Settings consumed only during startup (Logger level, Loki transport).
// They remain active until the process restarts, so a config change
// touching any of them must be reported as restart-required.
export const RESTART_REQUIRED_FIELDS = ["logLevel", "lokiUrl", "lokiEnabled"] as const;
export type RestartRequiredField = (typeof RESTART_REQUIRED_FIELDS)[number];
export type RestartRequiredSettings = Pick<IConfig, RestartRequiredField>;

/**
 * Extracts the startup-owned (restart-required) settings from a configuration.
 */
export function getRestartRequiredSettings(config: IConfig): RestartRequiredSettings {
    return {
        logLevel: config.logLevel,
        lokiUrl: config.lokiUrl,
        lokiEnabled: config.lokiEnabled,
    };
}

/**
 * Compares a candidate configuration against the startup values that are
 * still active and reports whether a process restart is required before
 * all of the candidate's values are in effect.
 */
export function requiresRestart(candidate: IConfig, active: RestartRequiredSettings): boolean {
    const next = getRestartRequiredSettings(candidate);
    return RESTART_REQUIRED_FIELDS.some((field) => next[field] !== active[field]);
}

/**
 * Extracts Loki configuration from the full config.
 */
export function getLokiConfig(config: Config): { url: string; enabled: boolean } {
    return {
        url: config.lokiUrl ?? "",
        enabled: config.lokiEnabled ?? false,
    };
}

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
