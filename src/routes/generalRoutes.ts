/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type express from "express";
import { validateConfig, getConfigPath, loadConfig, getRestartRequiredSettings, requiresRestart } from "../common";
import type { RestartRequiredSettings } from "../common";
import { ensureError, write_file } from "../systemFunctions";
import type { ILogger, IPinger, IConfig, IDevice } from "../interfaces";
import { LogLevel } from "../interfaces";
import { Logger } from "../Logger";
import { APP_VERSION, APP_NAME } from "../version";
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
    status: string;
    bootdate: string;
};

type AboutInfo = {
    name: string;
    version: string;
    release: string;
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

type EndpointDetail = {
    name: string;
    route: string;
    verb: string;
    requestBody?: string;
    responseBody: string;
    description: string;
};

type EndpointsInfo = {
    endpoints: EndpointDetail[];
};

export const aboutInformation: AboutInformation = {
    about: {
        name: "IP Pinger Services",
        version: APP_VERSION,
        release: APP_NAME,
        author: "Randy Dodson (dodsonsoftware@gmail.com)",
        description: "**IP Pinger Services** is the network monitoring service for the **SensorNET** platform. " +
            "Built with Node.js and Express, it continuously checks the availability and responsiveness of configured devices using ICMP echo requests.\n\n" +
            "The **IP Pinger Services** loads device definitions from YAML configuration and performs scheduled ping cycles at configurable intervals. " +
            "For each device, it records online or offline status, round- trip latency, last successful and failed checks, and categorized errors such as " +
            "timeouts and unreachable hosts.\n\nThe **IP Pinger Services** exposes Prometheus metrics for device availability, latency distribution, monitoring " +
            "- cycle duration, timestamps, and network errors.These metrics support Grafana dashboards, alerting, historical analysis, and early detection of " +
            "connectivity or performance issues.\n\nRuntime configuration updates allow devices and monitoring settings to be changed without restarting the " +
            "service. Health endpoints, structured logging, and automatic cleanup of metrics for removed devices support reliable production operation.",
        copyright: "Copyright © 2026 dodson Software ( dodson labs )",
        license: "MIT License"
    },
    system: {
        status: "healthy",
        bootdate: ""
    },
    commands: {
        "name": "General",
        "help": {
            "description": "IP Pinger Services",
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
                },
                {
                    "route": "/health",
                    "description": "Health check endpoint for container orchestration."
                },
                {
                    "route": "/endpoints",
                    "description": "Returns detailed information about each API endpoint."
                }
            ]
        }
    }
};

// **** ENDPOINTS Information
export const endpointsInfo: EndpointsInfo = {
    endpoints: [
        {
            name: "About",
            route: "/about",
            verb: "GET",
            requestBody: "None",
            responseBody: "Service information including about, system, and commands sections",
            description: "Returns service information and available commands."
        },
        {
            name: "Ping All",
            route: "/ping",
            verb: "GET",
            requestBody: "None",
            responseBody: "Array of ping results for all configured devices",
            description: "Pings all configured devices."
        },
        {
            name: "Ping Target",
            route: "/ping/:target",
            verb: "GET",
            requestBody: "None",
            responseBody: "Ping result for the specified IP address",
            description: "Pings the specified IP address and returns the result."
        },
        {
            name: "Read Config",
            route: "/read-config",
            verb: "GET",
            requestBody: "None",
            responseBody: "Current YAML configuration loaded from disk",
            description: "Reads the current configuration."
        },
        {
            name: "Write Config",
            route: "/write-config",
            verb: "POST",
            requestBody: "JSON object with keys: logLevel (string), intervalSecs (positive integer), devices (array of objects with source, ipAddress, deviceType), lokiUrl (string, optional), lokiEnabled (boolean, optional). The API port is fixed at 3300 and is not configurable.",
            responseBody: "{ success: boolean, restartRequired: boolean, message: string }",
            description: "Updates the configuration and reloads it. Hot-reloadable settings (intervalSecs, devices) apply immediately; logLevel, lokiUrl, and lokiEnabled require a process restart."
        },
        {
            name: "Reload Config",
            route: "/reload-config",
            verb: "GET",
            requestBody: "None",
            responseBody: "{ success: boolean, restartRequired: boolean, message: string }",
            description: "Reloads the configuration from disk without changing the payload. Reports whether a restart is required for startup-owned settings."
        },
        {
            name: "Metrics",
            route: "/metrics",
            verb: "GET",
            requestBody: "None",
            responseBody: "Prometheus metrics in text format",
            description: "Returns Prometheus metrics for scraped devices."
        },
        {
            name: "Health",
            route: "/health",
            verb: "GET",
            requestBody: "None",
            responseBody: "{ status: \"healthy\", timestamp: \"ISO-date-string\" }",
            description: "Health check endpoint for container orchestration."
        },
        {
            name: "Endpoints",
            route: "/endpoints",
            verb: "GET",
            requestBody: "None",
            responseBody: "Object containing an array of endpoint details",
            description: "Returns detailed information about each API endpoint."
        }
    ]
};

// **** PRIVATE Constants

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
    // Route state is owned by this invocation: each createRoutes() call —
    // and therefore each Pinger instance — carries its own configuration,
    // pinger, logger, and startup baseline, so registering routes for a
    // second instance can never rebind routes registered for a first one.
    let configuration = config_str;
    let configurationObj = config;
    const ip_pinger = pinger;
    const log_writer = logger;
    // Startup-owned settings that remain active until the process restarts.
    // Captured once at boot so reload comparisons are never skewed by later config writes.
    const startup_settings = getRestartRequiredSettings(config);
    aboutInformation.system.bootdate = startDate.toISOString();

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
     *                     release:
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
     *                     status:
     *                       type: string
     *                     bootdate:
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
     *     description: Reads the configuration file without applying it to the running service. Use /reload-config to apply it.
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
            // Read and validate the configuration file without touching running
            // application state. Applying disk configuration to the running
            // service is the job of /reload-config.
            const [newConfig, config_text] = loadConfig(log_writer);

            // Log the read configuration
            Logger.write_local_log(
                LogLevel.Info,
                originator + ".read-config",
                `Configuration read:\n${config_text}`
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
     *                 success:
     *                   type: boolean
     *                 restartRequired:
     *                   type: boolean
     *                 message:
     *                   type: string
     *             example:
     *               {
     *                   "success": true,
     *                   "restartRequired": false,
     *                   "message": "Configuration updated successfully."
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
                        success: false,
                        message: writeSuccess.error || `ERROR: Failed to write configuration file.`
                    });
                    return;
                }

                // Use loadConfig to properly parse and convert the config
                const [newConfig, config_text] = loadConfig(log_writer);

                // Update internal route state (persisted configuration)
                configuration = config_text;
                configurationObj = newConfig;

                // Compare startup-owned settings against the values still active.
                // The comparison baseline is captured at boot and never updated here,
                // so later reloads keep reporting restart-required accurately.
                const restartRequired = requiresRestart(newConfig, startup_settings);

                // Apply only the hot-reloadable settings (intervalSecs, devices)
                // to the running pinger.
                if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                    ip_pinger.updateConfig(newConfig, config_text);
                }

                // Log the newly loaded configuration
                Logger.write_local_log(
                    LogLevel.Info,
                    originator + ".write-config",
                    `Configuration reloaded:\n${config_text}`
                );

                res.status(OK).json({
                    success: true,
                    restartRequired: restartRequired,
                    message: restartRequired
                        ? "Configuration saved. Restart required for some changes to take effect."
                        : "Configuration updated successfully."
                });

            } else {
                res.status(_400).json({
                    success: false,
                    message: `VALIDATION ERROR: Invalid configuration data received.`,
                    errors: validData.errors
                });
            }
        } catch (error) {
            res.status(_400).json({
                success: false,
                message: `ERROR: Invalid configuration data received: ${ensureError(error).message}`
            });
        }
    });

    /**
     * @swagger
     * /reload-config:
     *   get:
     *     summary: Reloads the configuration from disk.
     *     description: Reloads the configuration from disk without changing the payload. Applies the hot-reloadable settings to the running pinger and reports whether a restart is required for startup-owned settings.
     *     responses:
     *       200:
     *         description: Configuration reloaded successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                 restartRequired:
     *                   type: boolean
     *                 message:
     *                   type: string
     *       400:
     *         description: Invalid configuration on disk or could not find config file
     */
    app.route("/reload-config").get((req: express.Request, res: express.Response) => {
        try {
            // Use loadConfig to properly parse and convert the config
            const [newConfig, rawText] = loadConfig(log_writer);

            // Update internal route state (persisted configuration)
            configuration = rawText;
            configurationObj = newConfig;

            // Compare startup-owned settings against the values still active
            const restartRequired = requiresRestart(newConfig, startup_settings);

            // Apply only the hot-reloadable settings (intervalSecs, devices)
            // to the running pinger
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
            res.status(OK).json({
                success: true,
                restartRequired: restartRequired,
                message: restartRequired
                    ? "Configuration reloaded. Restart required for some changes to take effect."
                    : "Configuration reloaded successfully."
            });

        } catch (error) {
            res.status(_400).json({
                success: false,
                message: `ERROR: Failed to reload configuration: ${ensureError(error).message}`
            });
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

    /**
     * @swagger
     * /health:
     *   get:
     *     summary: Health check endpoint.
     *     description: Returns health status for container orchestration (Kubernetes liveness/readiness probes).
     *     responses:
     *       200:
     *         description: Service is healthy
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 status:
     *                   type: string
     *                   example: "healthy"
     *                 timestamp:
     *                   type: string
     *                   format: date-time
     */
    app.route("/health").get((req: express.Request, res: express.Response) => {
        res.type(Json).status(OK).json({
            status: "healthy",
            timestamp: new Date().toISOString()
        });
    });

    /**
     * @swagger
     * /endpoints:
     *   get:
     *     summary: Get API endpoint details.
     *     description: Returns detailed information about each API endpoint including name, route, HTTP verb, request body expectations, and response format.
     *     responses:
     *       200:
     *         description: Array of endpoint details
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 endpoints:
     *                   type: array
     *                   items:
     *                     type: object
     *                     properties:
     *                       name:
     *                         type: string
     *                       route:
     *                         type: string
     *                       verb:
     *                         type: string
     *                       requestBody:
     *                         type: string
     *                       responseBody:
     *                         type: string
     *                       description:
     *                         type: string
     */
    app.route("/endpoints").get((req: express.Request, res: express.Response) => {
        res.type(Json).status(OK).json(getEndpoints());
    });

    // Ping helpers live in this invocation's closure so every request is
    // answered by the pinger instance these routes were registered with.
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
}

// ******** PRIVATE Functions

function getAbout() {
    // log it
    // console.log removed for production
    return aboutInformation;
}

function getEndpoints() {
    return endpointsInfo;
}
