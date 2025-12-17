/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import { join } from "path";
import { IConfig, IDevice } from "./interfaces";
import { readFileSync } from "fs";
import { z } from "zod";

export function loadConfig(fileName: string): [IConfig, string] {
    try {
        // read the file (synchronously for simplicity)
        const filePath = join(__dirname, fileName);
        const rawText = readFileSync(filePath, "utf-8");

        // parse the JSON – this gives a plain object
        const data = JSON.parse(rawText) as Record<string, unknown>;

        // validate
        if (!validateConfig(rawText).ok) {
            // invalid json
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
        const docker_container_name = get<string>(data, "docker-container-name");
        const log_level = get<string>(data, "log-level");
        const always_log_errors = get<boolean>(data, "always-log-errors");
        const prometheus_port = get<number>(data, "prometheus-port");
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
                docker_container_name,
                log_level,
                always_log_errors,
                prometheus_port,
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
    "docker-container-name": z.string(),
    "log-level": z.enum(["debug", "info", "warn", "error"]),
    "always-log-errors": z.boolean(),
    "prometheus-port": z.number().int().positive(),
    "interval-secs": z.number().int().positive(),
    devices: z.array(DeviceSchema),
});

/* ---------- Validation function ---------- */
export type Device = z.infer<typeof DeviceSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function validateConfig(json: string): { ok: true; data: Config } | { ok: false; errors: string[] } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (e) {
        return { ok: false, errors: ["Invalid JSON format."] };
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
