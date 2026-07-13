/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type express from "express";
import { validateConfig, getConfigPath, loadConfig } from "../common";
import { ensureError, write_file, read_file_json } from "../systemFunctions";
import type { ILogger, IPinger, IConfig, IDevice } from "../interfaces";
import { LogLevel } from "../interfaces";
import { Logger } from "../Logger";
import { join } from "path";
import { dump } from "js-yaml";
import { register } from "prom-client";

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

type CommandHelp = {
    route: string;
    description: string;
};

type HelpInfo = {
    description: string;
    commands: CommandHelp[];
};

type CommandsInfo = {
    name: string;
    help: HelpInfo;
};

type SystemInfo = {
    startDate: string;
};

type AboutInfo = {
    name: string;
    version: string;
    author: string;
    description: string;
    copyright: string;
    license: string;
};

type AboutInformation = {
    about: AboutInfo;
    system: SystemInfo;
    commands: CommandsInfo;
};

// **** PRIVATE Variables for runtime state
var start_date: Date;

export const aboutInformation: AboutInformation = {
    about: {
        name: "IP Pinger Service",
        version: (packageData?.get("version") as string) ?? "unknown",
        author: "Randy Dodson (dodsonsoftware@gmail.com)",
        description: "Provides device ping information with hot-reload configuration support.",
        copyright: "Copyright (c) 2026 dodson Software ( dodson labs )",
        license: "MIT License"
    },
    system: {
        startDate: new Date().toISOString()
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
                },
                {
                    "route": "/metrics",
                    "description": "Returns Prometheus metrics for scraped devices."
                }
            ]
        }
    }
};

// **** PRIVATE Variables

var configuration: string;
var configurationObj: IConfig;
var ip_pinger: IPinger;
var log_writer: ILogger;
const originator: string = "generalRoutes";

// Define types for ping results
interface PingResult {
    ipAddress: string;
    isAlive: boolean;
    roundTripMs: number;
    source?: string;
    deviceType?: string;
    error?: string;
}

// ******** CREATE Routes

export function createRoutes(app: express.Application, config: IConfig, config_str: string, pinger: IPinger, logger: ILogger, startDate: Date) {
    // **** initialize
    configuration = config_str;
    configurationObj = config;
    ip_pinger = pinger;
    log_writer = logger;
    start_date = startDate;
    aboutInformation.system.startDate = startDate.toISOString();

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
     *                   type: object
     *                   properties:
     *                     name:
     *                       type: string
     *                     version:
     *                       type: string
     *                     author:
     *                       type: string
     *                     description:
     *                       type: string
     *                     copyright:
     *                       type: string
     *                     license:
     *                       type: string
     *                 system:
     *                   type: object
     *                   properties:
     *                     startDate:
     *                       type: string
     *                       format: date-time
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
        // configurationObj is now IConfig which has devices: IDevice[]
        // So we can safely access it without additional runtime checks
        const devices = configurationObj.devices;
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
     *                 ipAddress:
     *                   type: string
     *                   example: "192.168.1.1"
     *                 isAlive:
     *                   type: boolean
     *                   example: true
     *                 roundtripMs:
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
            const [newConfig, config_text] = loadConfig(log_writer);

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
                `Configuration loaded:\n${config_text}`
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
     *                  "logLevel": "info",
     *                  "alwaysLogErrors": true,
     *                  "prometheusPort": 3300,
     *                  "intervalSecs": 30,
     *                  "devices": [
     *                      {
     *                          "source": "S1: Inside",
     *                          "ipAddress": "192.168.7.59",
     *                          "deviceType": "sensor"
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
                // Use validated data directly instead of re-parsing
                const yamlStr = dump(validData.data);

                // Write to the Docker-mounted config path with formatted YAML
                const writeSuccess = write_file(getConfigPath(), yamlStr, log_writer);

                if (!writeSuccess.success) {
                    res.status(_400).json({
                        message: writeSuccess.error || `ERROR: Failed to write configuration file.`
                    });
                    return;
                }

                // Use loadConfig to properly parse and convert the config
                const [newConfig, config_text] = loadConfig(log_writer);

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
                    `Configuration reloaded:\n${config_text}`
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
            const [newConfig, rawText] = loadConfig(log_writer);

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
                `Configuration reloaded:\n${rawText}`
            );

            log_writer.write_info("generalRoutes.reload-config", `Configuration reloaded successfully.`);
            res.status(OK).json({ message: "Configuration reloaded successfully." });

        } catch (error) {
            res.status(_400).json({ message: `ERROR: Failed to reload configuration: ${ensureError(error).message}` });
        }
    });

    /**
     * @swagger
     * /metrics:
     *   get:
     *     summary: Returns Prometheus metrics.
     *     description: Returns Prometheus metrics in text format for scraping by Prometheus.
     *     responses:
     *       200:
     *         description: Prometheus metrics in text format
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     */
    app.route("/metrics").get(async (req: express.Request, res: express.Response) => {
        const metrics = await register.metrics();
        res.set("Content-Type", register.contentType);
        res.end(metrics);
    });
}

// ******** PRIVATE Functions

function getAbout() {
    // log it
    // console.log removed for production
    return aboutInformation;
}

async function getPing(ipAddress: string): Promise<PingResult> {
    // ping device
    const [isAlive, roundTripMs] = await ip_pinger.ping_device(ipAddress);

    // return results
    return {
        ipAddress,
        isAlive,
        roundTripMs
    };
}

async function getPings(devices: IDevice[]): Promise<PingResult[]> {
    // iterate thru each device in devices
    const results: PromiseSettledResult<PingResult>[] = await Promise.allSettled(
        devices.map(async (device) => {
            try {
                // init
                const source = String(device.source);
                const ipAddress = String(device.ipAddress);
                const deviceType = String(device.deviceType);

                // ping device, add the source and return the results
                let dude = await getPing(ipAddress);
                dude.source = source;
                dude.deviceType = deviceType;
                return dude;
            } catch (err) {
                // Return error info with device context preserved
                return {
                    source: String(device.source),
                    ipAddress: String(device.ipAddress),
                    deviceType: String(device.deviceType),
                    isAlive: false,
                    roundTripMs: 0,
                    error: ensureError(err).message
                };
            }
        })
    );

    // Extract the value from each fulfilled result (or reason if rejected)
    return results.map(result =>
        result.status === 'fulfilled' ? result.value : result.reason
    );
}
