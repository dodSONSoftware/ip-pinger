/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type { IConfig, IDevice } from "./interfaces";
import { readFileSync } from "fs";
import { z } from "zod";
import { getEnvironmentVariable } from "./systemFunctions";
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

export function loadConfig(): [IConfig, string] {
    try {
        // read the file (synchronously for simplicity)
        const rawText = readFileSync(CONFIG_PATH, "utf-8");

        // parse the YAML – this gives a plain object
        const data = load(rawText) as Record<string, unknown>;

        // validate
        if (!validateConfig(rawText).ok) {
            // invalid yaml
            throw new Error(`Invalid configuration.`);
        }

        // helper to assert a property exists and has the expected type
        const get = <T>(obj: Record<string, unknown>, key: string): T => {
            if (!(key in obj)) {
                throw new Error(`Missing config key: ${key}`);
            }
            return obj[key] as T;
        };

        // extract primitive fields
        const log_level = get<string>(data, "log-level");
        const always_log_errors = get<boolean>(data, "always-log-errors");
        const prometheus_port = get<number>(data, "prometheus-port");
        const api_port = get<number>(data, "api-port");
        const interval_secs = get<number>(data, "interval-secs");

        // convert the raw devices array to IDevice[]
        const rawDevices = get<any[]>(data, "devices");
        const devices: IDevice[] = rawDevices.map((d) => ({
            source: d.source,
            ip_address: d["ip-address"],
            device_type: d["device-type"],
        }));

        // return the typed config object
        return [
            {
                log_level,
                always_log_errors,
                prometheus_port,
                api_port,
                interval_secs,
                devices,
            },
            rawText,
        ];
    } catch (err) {
        throw new Error(`Error in function common::loadConfig() -> ${(err as Error).message}`);
    }
}

/* ---------- Schema ---------- */
const ipRegex = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const DeviceSchema = z.object({
    source: z.string(),
    "ip-address": z.string().regex(ipRegex, "Invalid IP address"),
    "device-type": z.enum(["sensor", "controller", "kiosk"]),
});

const ConfigSchema = z.object({
    "log-level": z.enum(["debug", "info", "warn", "error"]),
    "always-log-errors": z.boolean(),
    "prometheus-port": z.number().int().positive(),
    "api-port": z.number().int().positive(),
    "interval-secs": z.number().int().positive(),
    devices: z.array(DeviceSchema),
});

/* ---------- Validation function ---------- */
export type Device = z.infer<typeof DeviceSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function validateConfig(yaml: string): { ok: true; data: Config } | { ok: false; errors: string[] } {
    let parsed: unknown;
    try {
        parsed = load(yaml);
    } catch (e) {
        return { ok: false, errors: ["Invalid YAML format."] };
    }

    const result = ConfigSchema.safeParse(parsed);
    if (result.success) {
        return { ok: true, data: result.data };
    }

    // Collect readable error messages
    const errors = result.error.issues.map((err) => {
        const path = err.path.length ? `(${err.path.join(" → ")})` : "";
        return `${err.message} ${path}`.trim();
    });

    return { ok: false, errors };
}
