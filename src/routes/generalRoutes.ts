/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type express from "express";
import { validateConfig, getConfigPath, loadConfig } from "../common";
import { ensureError, write_file, read_file_json } from "../systemFunctions";
import type { ILogger, IPinger} from "../interfaces";
import { IDevice, IPingResults, LogLevel } from "../interfaces";
import { Logger } from "../Logger";
import { readFileSync } from "fs";
import { join } from "path";
import { dump, load } from "js-yaml";

// CommonJS provides __dirname automatically

// **** HTTP Status Codes

export const OK = 200;
export const _400 = 400;
export const _418 = 418;
export const InternalServerError = 500;

// **** MIME Types

export const Text = "text/plain";
export const Json = "application/json";

// **** Load package.json for dynamic version
const packageJsonPath = join(__dirname, "..", "..", "package.json");
const packageData = read_file_json(packageJsonPath);

// **** STATIC Information

export const aboutInformation: Record<string, any> = {
    about: {
        name: "IP Pinger Service",
        version: packageData?.get("version") ?? "unknown",
        author: "Randy Dodson (dodsonsoftware@gmail.com)",
        description: "Provides device ping information with hot-reload configuration support.",
        copyright: "Copyright (c) 2026 dodson Software ( dodson labs )",
        license: "MIT License"
    },
    commands: {
        "name": "General",
        "help": {
            "description": "IP Pinger Service",
            "commands": [
                {
                    "route": "/about",
                    "description": "Returns service information and available commands."
                },
                {
                    "route": "/ping",
                    "description": "Pings all configured devices."
                },
                {
                    "route": "/ping/:target",
                    "description": "Pings the specified IP address and returns the result."
                },
                {
                    "route": "/read-config",
                    "description": "Reads the current configuration."
                },
                {
                    "route": "/write-config",
                    "description": "Updates the configuration and reloads it."
                },
                {
                    "route": "/reload-config",
                    "description": "Reloads the configuration from disk without changing the payload."
                }
            ]
        }
    }
};

// **** PRIVATE Variables

var configuration: string;
var configurationObj: Record<string, any>;
var ip_pinger: IPinger;
var log_writer: ILogger;
const originator: string = "generalRoutes";

// ******** CREATE Routes

export function createRoutes(app: express.Application, config: string, pinger: IPinger, logger: ILogger) {
    // **** initialize
    configuration = config;
    configurationObj = load(config) as Record<string, any>;
    ip_pinger = pinger;
    log_writer = logger;

    /**
     * @swagger
     * /about:
     *   get:
     *     summary: Retrieve information about the API.
     *     description: Returns a description of the API and its purpose.
     *     responses:
     *       200:
     *         description: A brief introduction to the API
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 about:
     *                   type: string
     *                 version:
     *                   type: string
     */
    app.route("/about").get((req: express.Request, res: express.Response) => {
        res.type(Json).status(OK).json(getAbout());
    });

    /**
     * @swagger
     * /ping:
     *   get:
     *     summary: Pings all configured devices.
     *     description: Returns all of the ping results.
     *     responses:
     *       200:
     *         description: Pings all devices and returns the results.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 about:
     *                   type: string
     *                 version:
     *                   type: string
     */
    app.route("/ping").get(async (req: express.Request, res: express.Response) => {
        const devices = configurationObj["devices"];
        const results = await getPings(devices);
        res.type("application/json").status(OK).json(results);
    });

    /**
     * @swagger
     * /ping/{target}:
     *   get:
     *     summary: Pings the given ip-address and returns the results.
     *     description: Returns the ping result for the specified target IP address.
     *     parameters:
     *       - name: target
     *         in: path
     *         required: true
     *         description: The IP address to ping
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Ping result for the target IP
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 ip_address:
     *                   type: string
     *                   example: "192.168.1.1"
     *                 is_alive:
     *                   type: boolean
     *                   example: true
     *                 roundtrip_ms:
     *                   type: number
     *                   example: 45
     */
    app.route("/ping/:target").get(async (req: express.Request, res: express.Response) => {
        res.type("application/json").status(OK).json(await getPing(String(req.params.target)));
    });

    /**
     * @swagger
     * /read-config:
     *   get:
     *     summary: Read the configuration file.
     *     description: Returns the configuration file.
     *     responses:
     *       200:
     *         description: The configuration file
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 about:
     *                   type: string
     *                 version:
     *                   type: string
     */
    app.route("/read-config").get((req: express.Request, res: express.Response) => {
        try {
            // Use loadConfig to properly parse and convert the config
            const [newConfig, config_text] = loadConfig();

            // Update in-memory cache
            configuration = config_text;
            configurationObj = newConfig;

            // Update the running pinger with the new configuration
            if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                ip_pinger.updateConfig(newConfig, config_text);
            }

            // Log the newly loaded configuration
            Logger.write_local_log(
                LogLevel.Info,
                originator + ".read-config",
                `Configuration loaded: ${config_text}`
            );

            res.type(Json).status(OK).json(newConfig);
        } catch (error) {
            res.status(_400).json({ message: `ERROR: Could not read config: ${ensureError(error).message}` });
        }
    });

    /**
     * @swagger
     * /write-config:
     *   post:
     *     summary: Write the payload to the configuration file.
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             additionalProperties: true
     *             example:
     *               {
     *                  "log-level": "info",
     *                  "always-log-errors": true,
     *                  "prometheus-port": 3300,
     *                  "interval-secs": 30,
     *                  "devices": [
     *                      {
     *                          "source": "S1: Inside",
     *                          "ip-address": "192.168.7.59",
     *                          "device-type": "sensor"
     *                      }
     *                  ]
     *              }
     *     responses:
     *       200:
     *         description: Data received and validated successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: string
     *                   example: Data received
     *             example:
     *               {
     *                   "message": "Valid configuration data received"
     *               }
     *       400:
     *         description: Bad Request
     */
    app.route("/write-config").post((req: express.Request, res: express.Response) => {
        try {
            // get body as json and verify
            const json_str = JSON.stringify(req.body);
            const validData = validateConfig(json_str);

            // check
            if (validData.ok) {
                // Parse the config to a plain object, then dump to YAML
                const parsedConfig = JSON.parse(json_str);
                const yamlStr = dump(parsedConfig);

                // Write to the Docker-mounted config path with formatted YAML
                write_file(getConfigPath(), yamlStr);

                // Use loadConfig to properly parse and convert the config
                const [newConfig, config_text] = loadConfig();

                // Update internal route state
                configuration = config_text;
                configurationObj = newConfig;

                if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                    ip_pinger.updateConfig(newConfig, config_text);
                }

                // Log the newly loaded configuration
                Logger.write_local_log(
                    LogLevel.Info,
                    originator + ".write-config",
                    `Configuration reloaded: ${config_text}`
                );

                res.status(OK).json({ message: "Valid configuration data received. Configuration saved and hot-reloaded." });

            } else {
                res.status(_400).json({ message: "VALIDATION ERROR: Invalid configuration data received.", errors: validData.errors });
            }
        } catch (error) {
            res.status(_400).json({ message: `ERROR: Invalid configuration data received: ${ensureError(error).message}` });
        }
    });

    /**
     * @swagger
     * /reload-config:
     *   get:
     *     summary: Reloads the configuration from disk.
     *     description: Reloads the configuration from disk without changing the payload. Updates the running pinger with the new configuration.
     *     responses:
     *       200:
     *         description: Configuration reloaded successfully
     *       400:
     *         description: Invalid configuration on disk or could not find config file
     */
    app.route("/reload-config").get((req: express.Request, res: express.Response) => {
        try {
            // Use loadConfig to properly parse and convert the config
            const [newConfig, rawText] = loadConfig();

            // Update internal route state
            configuration = rawText;
            configurationObj = newConfig;

            // Update the running pinger with the new configuration
            if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                ip_pinger.updateConfig(newConfig, rawText);
            }

            // Log the newly loaded configuration
            Logger.write_local_log(
                LogLevel.Info,
                originator + ".reload-config",
                `Configuration reloaded: ${rawText}`
            );

            log_writer.write_info("generalRoutes.reload-config", `Configuration reloaded successfully.`);
            res.status(OK).json({ message: "Configuration reloaded successfully." });

        } catch (error) {
            res.status(_400).json({ message: `ERROR: Failed to reload configuration: ${ensureError(error).message}` });
        }
    });
}

// ******** PRIVATE Functions

function getAbout() {
    // log it
    // console.log removed for production
    return aboutInformation;
}

async function getPing(ip_address: string): Promise<Record<string, any>> {
    // ping device
    const [is_alive, round_trip_ms] = await ip_pinger.ping_device(ip_address);

    // return results
    return {
        "ip_address": ip_address,
        "is_alive": is_alive,
        "roundtrip_ms": round_trip_ms
    };
}

async function getPings(devices: Record<string, any>[]): Promise<Record<string, any>> {
    // iterate thru each device in devices
    const results: any[] = await Promise.allSettled(
        devices.map(async (device) => {
            try {
                // init
                const source = String(device["source"]);
                const ip_address = String(device["ip_address"] ?? device["ip-address"]);
                const device_type = String(device["device_type"] ?? device["device-type"] ?? "");

                // ping device, add the source and return the results
                let dude = await getPing(ip_address);
                dude["source"] = source;
                dude["device_type"] = device_type;
                return dude;
            } catch (err) {
                // Return error info with device context preserved
                return {
                    source: String(device["source"]),
                    ip_address: String(device["ip_address"] ?? device["ip-address"]),
                    device_type: String(device["device_type"] ?? device["device-type"] ?? ""),
                    is_alive: false,
                    roundtrip_ms: 0,
                    error: ensureError(err).message
                };
            }
        })
    );

    // All results are now fulfilled (Promise.allSettled guarantees this),
    // so we can just return the array directly
    return results;
}
