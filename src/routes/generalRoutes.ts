/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import express from "express";
import { validateConfig, getConfigPath, loadConfig } from "../common";
import { ensureError, write_file } from "../systemFunctions";
import { IDevice, ILogger, IPinger, IPingResults } from "../interfaces";
import { readFileSync } from "fs";
import { join } from "path";

// **** HTTP Status Codes

export const OK = 200;
export const _400 = 400;
export const _418 = 418;
export const InternalServerError = 500;

// **** MIME Types

export const Text = "text/plain";
export const Json = "application/json";

// **** STATIC Information

export const aboutInformation: Record<string, any> = {
    about: {
        name: "IP Pinger Service",
        version: "1.2.0",
        author: "Randy Dodson (dodsonsoftware@gmail.com)",
        description: "Provides device ping information with hot-reload configuration support.",
        copyright: "Copyright (c) 2025-2026 dodson Software ( dodson labs )",
        license: "Licensed under the MIT License with Patent Grant and NOTICE preservation."
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
var config_json: Record<string, any>;
var ip_pinger: IPinger;
var log_writer: ILogger;

// ******** CREATE Routes

export function createRoutes(app: express.Application, config: string, pinger: IPinger, logger: ILogger) {
    // **** initialize
    configuration = config;
    config_json = JSON.parse(configuration);
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
        res.type("application/json").status(OK).json(await getPings(config_json["devices"]));
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
            const configPath = getConfigPath();
            const rawText = readFileSync(configPath, "utf-8");
            res.type(Json).status(OK).json(JSON.parse(rawText));
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
     *                  "docker-container-name": "ip-pinger-2",
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
                // Write to the Docker-mounted config path
                write_file(getConfigPath(), JSON.parse(JSON.stringify(json_str, null, 2)));

                // Use loadConfig to properly parse and convert the config
                const [newConfig, config_text] = loadConfig();
                if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                    ip_pinger.updateConfig(newConfig, config_text);
                }

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
            config_json = JSON.parse(rawText);

            // Update the running pinger with the new configuration
            if (ip_pinger && typeof ip_pinger.updateConfig === "function") {
                ip_pinger.updateConfig(newConfig, rawText);
            }

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
    const results: any[] = await Promise.all(devices.map(async (device) => {
        // init
        const source = String(device["source"]);
        const ip_address = String(device["ip-address"]);

        // ping device, add the source and return the results
        let dude = await getPing(ip_address);
        dude["source"] = source;
        return dude;
    }));

    // return all results
    return results;
}
