/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type express from "express";
import { IPV4_SCHEMA, validateConfig, getConfigPath, loadConfig, getRestartRequiredSettings, requiresRestart, RESTART_REQUIRED_FIELDS } from "../common";
import type { RestartRequiredSettings } from "../common";
import { ensureError, write_file } from "../systemFunctions";
import type { ILogger, IPinger, IConfig, IDevice, ConfigReloadResult, AdhocPingResult } from "../interfaces";
import { LogLevel } from "../interfaces";
import { Logger } from "../Logger";
import { APP_VERSION, APP_NAME } from "../version";
import { dump } from "js-yaml";
import { register } from "prom-client";

// CommonJS provides __dirname automatically

// **** HTTP Status Codes

export const OK = 200;
export const _400 = 400;
export const InternalServerError = 500;
export const ServiceUnavailable = 503;

// **** MIME Types

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

// **** ENDPOINTS Information
// The single source of truth for the route inventory: the /about command
// index (below) is derived from it so the two listings can never drift apart.
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
            requestBody: "JSON object with keys: logLevel (string), intervalSecs (positive integer), devices (array of objects with source, ipAddress, deviceType), lokiUrl (string, optional), lokiEnabled (boolean, optional). The API port is fixed at 32001 and is not configurable.",
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
            description: "Returns Prometheus metrics (device, application, and process) in text format."
        },
        {
            name: "Health",
            route: "/health",
            verb: "GET",
            requestBody: "None",
            responseBody: "{ status: \"healthy\" | \"unhealthy\", timestamp: \"ISO-date-string\", reason?: string } — 200 while operational, 503 after a fatal net-ping session failure",
            description: "Health check endpoint for container orchestration. Reports 503 unhealthy once the pinger is no longer operational."
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

export const aboutInformation: AboutInformation = {
    about: {
        name: "IP Pinger Services",
        version: APP_VERSION,
        release: APP_NAME,
        author: "Randy Dodson (dodsonsoftware@gmail.com)",
        description: "**IP Pinger Services** is the network monitoring service for the **SensorNET** platform. " +
            "Built with Node.js and Express, it continuously checks the availability and responsiveness of configured devices using ICMP echo requests.\n\n" +
            "The **IP Pinger Services** loads device definitions from YAML configuration and performs scheduled ping cycles at configurable intervals. " +
            "For each device, it records online or offline status, round-trip latency, last successful and failed checks, and categorized errors such as " +
            "timeouts and unreachable hosts.\n\nThe **IP Pinger Services** exposes Prometheus metrics for device availability, latency distribution, monitoring " +
            "cycle duration, timestamps, and network errors, as well as application-level metrics (operational state, configuration state and reload outcomes, " +
            "cycle timing, and log-transport health) and standard Node.js process metrics. These metrics support Grafana dashboards, alerting, historical " +
            "analysis, and early detection of connectivity or performance issues.\n\nRuntime configuration updates allow devices and monitoring settings to be " +
            "changed without restarting the service. Health endpoints, structured logging, and automatic cleanup of metrics for removed devices support " +
            "reliable production operation.",
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
            // Derived from endpointsInfo so the /about index and the /endpoints
            // catalog always agree on the routes and their descriptions.
            "commands": endpointsInfo.endpoints.map(({ route, description }) => ({ route, description }))
        }
    }
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
    // and therefore each Pinger instance — carries its own configuration
    // object, pinger, logger, startup baseline, and about payload, so
    // registering routes for a second instance can never rebind routes
    // registered for a first one. The raw config text lives on the Pinger
    // itself (updateConfig), not in this closure.
    let configurationObj = config;
    const ip_pinger = pinger;
    const log_writer = logger;
    // Startup-owned settings that remain active until the process restarts.
    // Captured once at boot so reload comparisons are never skewed by later config writes.
    const startup_settings = getRestartRequiredSettings(config);
    // Instance-owned about payload: the static metadata above is shared
    // read-only, but the system block copies this invocation's boot date so
    // a second createRoutes() call can never overwrite a first instance's.
    // The system status is intentionally not copied here: it changes at
    // runtime (a fatal net-ping session failure), so the /about handler
    // computes it per request (see below) instead of serving the static
    // "healthy" baseline.
    const instanceAbout: AboutInformation = {
        ...aboutInformation,
        system: {
            ...aboutInformation.system,
            bootdate: startDate.toISOString(),
        }
    };

    // The validate→persist→apply sequences of /write-config and
    // /reload-config run under this lock so two overlapping requests can
    // never interleave and one response can claim a payload that was not
    // what got applied. Today both handlers are fully synchronous, so the
    // event loop already serializes them; the lock makes the invariant
    // structural — it stays true if a future edit introduces an async step
    // (e.g. fs.promises) anywhere mid-sequence.
    let configSequenceBusy = false;
    const configSequenceWaiters: Array<() => void> = [];
    function withConfigSequence(run: () => Promise<void>): void {
        const finish = (): void => {
            configSequenceBusy = false;
            configSequenceWaiters.shift()?.();
        };
        const attempt = (): void => {
            if (configSequenceBusy) {
                configSequenceWaiters.push(attempt);
                return;
            }
            configSequenceBusy = true;
            void run().then(finish, finish);
        };
        attempt();
    }

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
        // The operational state changes at runtime (a fatal net-ping
        // session failure flips isOperational() to false), so compute the
        // status at request time: an operator reading /about must never
        // see "healthy" while /health is already answering 503.
        res.type(Json).status(OK).json({
            ...instanceAbout,
            system: {
                ...instanceAbout.system,
                status: ip_pinger.isOperational() ? "healthy" : "unhealthy",
            }
        });
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
     *               type: array
     *               items:
     *                 type: object
     *                 properties:
     *                   ipAddress:
     *                     type: string
     *                     example: "192.168.1.1"
     *                   isAlive:
     *                     type: boolean
     *                   roundTripMs:
     *                     type: number
     *                   source:
     *                     type: string
     *                   deviceType:
     *                     type: string
     *                   error:
     *                     type: string
     *                     description: Present only when the ping for this device failed
     */
    app.route("/ping").get(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            // configurationObj is now IConfig which has devices: IDevice[]
            // So we can safely access it without additional runtime checks
            const devices = configurationObj.devices;
            const results = await getPings(devices);
            res.type("application/json").status(OK).json(results);
        } catch (error) {
            // Express 4 does not forward rejected async handlers to its
            // error path; hand the failure off explicitly so the error
            // middleware answers it as a controlled 500.
            next(error);
        }
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
     *         description: The IPv4 address to ping
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
     *                 roundTripMs:
     *                   type: number
     *                   example: 45
     *       400:
     *         description: The target is not a valid IPv4 address (the reserved addresses 0.0.0.0 and 255.255.255.255 are rejected)
     */
    app.route("/ping/:target").get(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const target = String(req.params.target);

            // The documented contract is an IPv4 address — the same
            // boundary validation applied to configured device addresses —
            // so reject anything else before it can reach net-ping.
            const parsed = IPV4_SCHEMA.safeParse(target);
            if (!parsed.success) {
                recordAdhocPing("invalid_target");
                res.status(_400).json({
                    success: false,
                    message: `ERROR: '${target}' is not a valid IPv4 address.`
                });
                return;
            }

            const result = await getPing(parsed.data);
            recordAdhocPing(result.isAlive ? "ok" : "down");
            res.type("application/json").status(OK).json(result);
        } catch (error) {
            // The only failure that can reach this catch is the ping
            // itself rejecting (validation and the 400 path above are
            // synchronous); the ping could not be performed at all
            recordAdhocPing("error");
            // Express 4 does not forward rejected async handlers to its
            // error path; hand the failure off explicitly so the error
            // middleware answers it as a controlled 500.
            next(error);
        }
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
     *                 logLevel:
     *                   type: string
     *                 intervalSecs:
     *                   type: integer
     *                 devices:
     *                   type: array
     *                   items:
     *                     type: object
     *                     properties:
     *                       source:
     *                         type: string
     *                       ipAddress:
     *                         type: string
     *                       deviceType:
     *                         type: string
     *                 lokiUrl:
     *                   type: string
     *                 lokiEnabled:
     *                   type: boolean
     */
    app.route("/read-config").get((req: express.Request, res: express.Response) => {
        try {
            // Read and validate the configuration file without touching running
            // application state. Applying disk configuration to the running
            // service is the job of /reload-config.
            // No logger here: the catch below is the single logging point for
            // a load failure, so one event produces one console + Loki entry
            // (loadConfig's own failure log would duplicate it).
            const [newConfig, config_text] = loadConfig();

            // Console-only by design: the full configuration dump stays in
            // docker logs and is not sent to Loki (see the split-sink
            // comments on /write-config and /reload-config below).
            Logger.write_local_log(
                LogLevel.Info,
                originator + ".read-config",
                `Configuration read:\n${config_text}`
            );

            res.type(Json).status(OK).json(newConfig);
        } catch (error) {
            // A failure here is a server-side condition (unreadable or
            // invalid config file), even though the route contract answers
            // it as a 400 — log it to console + Loki before answering.
            const err = ensureError(error);
            log_writer.write_error("generalRoutes.read-config", `Could not read config: ${err.name}: ${err.message}`);
            res.status(_400).json({ message: `ERROR: Could not read config: ${err.message}` });
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
     *       500:
     *         description: Unexpected server-side failure while processing the payload
     */
    app.route("/write-config").post((req: express.Request, res: express.Response) => {
        // The full validate→persist→apply sequence runs under the
        // config-sequence lock (see above), so an overlapping /write-config
        // or /reload-config cannot interleave with it; every path in
        // doWriteConfig responds, so no response is left dangling behind a
        // request still in flight.
        withConfigSequence(() => doWriteConfig(req, res));
    });

    async function doWriteConfig(req: express.Request, res: express.Response): Promise<void> {
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
                    // The payload validated, but nothing was applied
                    recordConfigReload("rejected");
                    res.status(_400).json({
                        success: false,
                        message: writeSuccess.error || `ERROR: Failed to write configuration file.`
                    });
                    return;
                }

                // Use loadConfig to properly parse and convert the config.
                // No logger: the catch below is the single logging point for
                // a load failure (one event, one console + Loki entry).
                const [newConfig, config_text] = loadConfig();

                // Update internal route state (persisted configuration)
                configurationObj = newConfig;

                // Compare startup-owned settings against the values still active.
                // The comparison baseline is captured at boot and never updated here,
                // so later reloads keep reporting restart-required accurately.
                const restartRequired = requiresRestart(newConfig, startup_settings);
                logRestartRequired("write-config", newConfig, restartRequired);

                // Apply only the hot-reloadable settings (intervalSecs, devices)
                // to the running pinger.
                if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                    ip_pinger.updateConfig(newConfig, config_text);
                }
                recordConfigReload("success");

                // Intentional split sinks: the full configuration dump goes
                // to the console only (docker logs) via the static writer,
                // while the instance-logger summary of this update (the
                // pinger's "Configuration updated." line) also reaches Loki.
                // This keeps large, repetitive configuration dumps out of
                // the Loki log store.
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
                // An invalid payload answers 400 but would otherwise leave
                // no trace of why the write failed — log the validation
                // errors, not just the fact of the rejection
                recordConfigReload("rejected");
                log_writer.write_warn(
                    originator + ".write-config",
                    `Configuration payload rejected: ${validData.errors.join("; ")}`
                );
                res.status(_400).json({
                    success: false,
                    message: `VALIDATION ERROR: Invalid configuration data received.`,
                    errors: validData.errors
                });
            }
        } catch (error) {
            // Validation failures answer 400 via the branch above; anything
            // reaching this catch is an unexpected server-side failure (a
            // throw in dump/write/re-read) — answer 500 so client-error
            // monitoring does not absorb a server failure, and log it to
            // console + Loki before answering.
            const err = ensureError(error);
            recordConfigReload("rejected");
            log_writer.write_error("generalRoutes.write-config", `Unexpected error processing configuration payload: ${err.name}: ${err.message}`);
            res.status(InternalServerError).json({
                success: false,
                message: `ERROR: Internal error while processing the configuration payload: ${err.message}`
            });
        }
    }

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
        // The load→apply sequence runs under the same config-sequence lock
        // as /write-config (see above), so a reload cannot interleave with a
        // write that is mid-sequence on the shared file.
        withConfigSequence(() => doReloadConfig(req, res));
    });

    async function doReloadConfig(req: express.Request, res: express.Response): Promise<void> {
        try {
            // Use loadConfig to properly parse and convert the config.
            // No logger: the catch below is the single logging point for a
            // load failure (one event, one console + Loki entry).
            const [newConfig, rawText] = loadConfig();

            // Update internal route state (persisted configuration)
            configurationObj = newConfig;

            // Compare startup-owned settings against the values still active
            const restartRequired = requiresRestart(newConfig, startup_settings);
            logRestartRequired("reload-config", newConfig, restartRequired);

            // Apply only the hot-reloadable settings (intervalSecs, devices)
            // to the running pinger
            if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                ip_pinger.updateConfig(newConfig, rawText);
            }
            recordConfigReload("success");

            // Intentional split sinks: the full configuration dump goes to
            // the console only (docker logs) via the static writer, while
            // the one-line summary below uses the instance logger and
            // therefore also reaches Loki. This keeps large, repetitive
            // configuration dumps out of the Loki log store.
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
            // A failure here is a server-side condition (unreadable or
            // invalid config file), even though the route contract answers
            // it as a 400 — log it to console + Loki before answering.
            const err = ensureError(error);
            recordConfigReload("rejected");
            log_writer.write_error("generalRoutes.reload-config", `Failed to reload configuration: ${err.name}: ${err.message}`);
            res.status(_400).json({
                success: false,
                message: `ERROR: Failed to reload configuration: ${err.message}`
            });
        }
    }

    /**
     * @swagger
     * /metrics:
     *   get:
     *     summary: Returns Prometheus metrics.
     *     description: Returns Prometheus metrics (device, application, and process) in text format for scraping by Prometheus.
     *     responses:
     *       200:
     *         description: Prometheus metrics in text format
     *         content:
     *           text/plain:
     *             schema:
     *               type: string
     */
    app.route("/metrics").get(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const metrics = await register.metrics();
            res.set("Content-Type", register.contentType);
            res.end(metrics);
        } catch (error) {
            // Express 4 does not forward rejected async handlers to its
            // error path; hand the failure off explicitly so the error
            // middleware answers it as a controlled 500.
            next(error);
        }
    });

    /**
     * @swagger
     * /health:
     *   get:
     *     summary: Health check endpoint.
     *     description: Returns health status for container orchestration (Kubernetes liveness/readiness probes). Reports 503 once the net-ping session has failed and the pinger is no longer operational, so the orchestrator can restart the process.
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
     *       503:
     *         description: Service is unhealthy — the net-ping session failed and the pinger is no longer operational
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 status:
     *                   type: string
     *                   example: "unhealthy"
     *                 reason:
     *                   type: string
     *                 timestamp:
     *                   type: string
     *                   format: date-time
     */
    app.route("/health").get((req: express.Request, res: express.Response) => {
        const timestamp = new Date().toISOString();

        if (ip_pinger.isOperational()) {
            res.type(Json).status(OK).json({
                status: "healthy",
                timestamp: timestamp
            });
        } else {
            // The net-ping session has failed and been closed: the pinger
            // is no longer monitoring anything. Report non-2xx so the
            // container orchestrator can restart the process, which
            // recreates the session.
            res.type(Json).status(ServiceUnavailable).json({
                status: "unhealthy",
                reason: "net-ping session failure: the pinger is no longer operational",
                timestamp: timestamp
            });
        }
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
        res.type(Json).status(OK).json(endpointsInfo);
    });

    // **** Application-level error handler
    // Express 4 does not automatically forward rejected promises from async
    // route handlers to its error-handling path (that behavior exists only in
    // Express 5). The async handlers above therefore call next(error) on
    // failure, and this middleware turns each handoff into a logged,
    // controlled JSON response instead of an unhandled rejection that
    // could crash the process. It must be registered after all routes so it
    // only receives forwarded errors, not unmatched requests. It is also the
    // single place a body-parser failure on /write-config surfaces (the
    // handler never runs), so it records those as rejected_parse in
    // pinger_config_reload_total — see the guard below.
    app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
        const err = ensureError(error);

        // Body-parser failures (e.g., malformed JSON -> 400, payload over
        // the default 100kb limit -> 413) carry their HTTP status on the
        // error; respect it so client errors are not answered as a server
        // failure. Anything without an integer 400-599 status (e.g., a
        // rejecting route handler) is a server failure and keeps the 500.
        const errWithStatus = err as Error & { status?: unknown; statusCode?: unknown; type?: unknown };
        const carried = Number(errWithStatus.status ?? errWithStatus.statusCode);
        const httpStatus = Number.isInteger(carried) && carried >= _400 && carried <= 599
            ? carried
            : InternalServerError;

        // A request body that failed JSON parsing (400 malformed / 413 too
        // large) on the config-write route never reaches the /write-config
        // handler, whose recordConfigReload calls therefore never run. Record
        // it here as the distinct rejected_parse outcome so it is visible in
        // the metric, not only the log. The route guard is required: body
        // parsing is app-wide, so a parse failure on any other route is not a
        // configuration reload attempt.
        if (
            req.method === "POST" &&
            req.path === "/write-config" &&
            typeof errWithStatus.type === "string" &&
            errWithStatus.type.startsWith("entity.")
        ) {
            recordConfigReload("rejected_parse");
        }

        if (res.headersSent) {
            // The response already started; defer to Express's default
            // finalhandler so the connection is closed with the failure.
            next(err);
            return;
        }

        // A forwarded 4xx is the caller's fault, not a server failure; log warn.
        if (httpStatus < InternalServerError) {
            log_writer.write_warn(
                originator + ".error-handler",
                `${req.method} ${req.url} failed: ${err.name}: ${err.message}`
            );
        } else {
            log_writer.write_error(
                originator + ".error-handler",
                `${req.method} ${req.url} failed: ${err.name}: ${err.message}`
            );
        }

        res.type(Json).status(httpStatus).json({
            success: false,
            message: `ERROR: ${req.method} ${req.url} failed: ${err.message}`
        });
    });

    // The response reports restartRequired as a bare boolean; the log
    // names the specific settings, because the log is where an operator
    // checks whether a just-pushed logLevel/lokiUrl/lokiEnabled change
    // took effect — it does not, those stay startup-owned until a restart
    function logRestartRequired(where: string, config: IConfig, restartRequired: boolean): void {
        if (!restartRequired) {
            return;
        }
        const restartFields = RESTART_REQUIRED_FIELDS.filter(
            (field) => config[field] !== startup_settings[field]
        );
        log_writer.write_info(
            originator + "." + where,
            `Restart required for: ${restartFields.join(", ")} (active only after a process restart).`
        );
    }

    // The route handlers report reload and ad-hoc-ping outcomes to the
    // running pinger, which owns the counters (pinger_config_reload_total,
    // pinger_adhoc_ping_total) — the same guarded-call pattern the
    // updateConfig calls use.
    function recordConfigReload(result: ConfigReloadResult): void {
        if (ip_pinger && typeof ip_pinger.recordConfigReload === "function") {
            ip_pinger.recordConfigReload(result);
        }
    }

    function recordAdhocPing(result: AdhocPingResult): void {
        if (ip_pinger && typeof ip_pinger.recordAdhocPing === "function") {
            ip_pinger.recordAdhocPing(result);
        }
    }

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
        // iterate thru each device in devices. Every callback catches its
        // own failure and returns an error result object, so no inner
        // promise can reject — Promise.all resolves as soon as every
        // device has a result.
        return Promise.all(
            devices.map(async (device) => {
                try {
                    // init
                    const source = String(device.source);
                    const ipAddress = String(device.ipAddress);
                    const deviceType = String(device.deviceType);

                    // ping device, add the source and return the results
                    let dude = await getPing(ipAddress);
                    recordAdhocPing(dude.isAlive ? "ok" : "down");
                    dude.source = source;
                    dude.deviceType = deviceType;
                    return dude;
                } catch (err) {
                    // The ping could not be performed at all (distinct from
                    // a completed ping the device did not answer)
                    recordAdhocPing("error");
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
    }
}
