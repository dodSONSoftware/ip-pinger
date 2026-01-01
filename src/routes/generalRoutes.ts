/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import express from "express";
import { validateConfig } from "../common";
import { ensureError, executeCommandLine_Command, sleep, write_file } from "../systemFunctions";
import { IDevice, IPinger, IPingResults } from "../interfaces";
import { boolean, number } from "zod";
import { PingResults } from "../PingResults";

// **** HTTP Status Codes

export const OK = 200;
export const InternalServerError = 500;

// **** MIME Types

export const Text = "text/plain";
export const Json = "application/json";

// **** STATIC Information

const aboutInformation = {
    name: "IP Pinger Service",
    version: "1.0.0",
    author: "dodson labs",
    description: "Provides device ping information.",
};

// **** PRIVATE Variables

var configuration: string;
var config_json: Record<string, any>;
var ip_pinger: IPinger;

// ******** CREATE Routes

export function createRoutes(app: express.Application, config: string, pinger: IPinger) {
    // **** initialize
    configuration = config;
    config_json = JSON.parse(configuration);
    ip_pinger = pinger;

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
        await res.type("application/json").status(OK).json(await getPings(config_json["devices"]));
    });

    /**
     * @swagger
     * /ping/{target}:
     *   get:
     *     summary: Pings the given ip-address and return the results.
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
    app.route("/ping/:target").get(async (req: express.Request, res: express.Response) => {
        await res.type("application/json").status(OK).json(await getPing(req.params.target));
    });

    /**
     * @swagger
     * /read-config:
     *   get:
     *     summary: Read the configuration file
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
        res.type(Json).status(OK).json(JSON.parse(configuration));
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
            const json_str = JSON.stringify(req.body);



            console.log(`\n>>>>>>>>\n${JSON.stringify(req.body)}\n<<<<<<<<\n`);



            const validData = validateConfig(json_str);
            if (validData.ok) {
                res.status(200).json({ message: "Valid configuration data received" });
                write_file("./config.json", json_str);

            } else {
                res.status(400).json({ message: "VALIDATION ERROR: Invalid configuration data received", errors: validData.errors });
            }
        } catch (error) {
            res.status(400).json({ message: `ERROR: Invalid configuration data received: ${ensureError(error).message}` });
        }
    });

    /**
     * @swagger
     * /restart:
     *   post:
     *     summary: Execute a script that will restart the docker container that the IP Pinger is contained in.
     *     requestBody:
     *       required: false
     *     responses:
     *       200:
     *         description: Restarting docker container
     *       418:
     *         description: Error
     */
    app.route("/restart").post(async (req: express.Request, res: express.Response) => {
        try {
            // ! ################################################################

            // TODO: ... FIX THIS ...

            const script_str = `docker container restart ${config_json["docker-container-name"]}`;
            console.log(`\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> EXECUTING --> ${script_str}\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`);
            res.status(200).json({ message: `Restarting docker container` });
            await sleep(1000);
            console.log("<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<");
            //await executeCommandLine_Command(script_str);

            // ! ################################################################
        } catch (error) {
            res.status(418).json({ message: (error as Error).message });
        }
    });
}

// ******** PRIVATE Functions

function getAbout() {
    // log it
    console.log("generalRoutes.ts/getAbout", JSON.stringify(aboutInformation));
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

        // ping device
        const [is_alive, round_trip_ms] = await ip_pinger.ping_device(ip_address);

        // return results
        return {
            "source": source,
            "ip_address": ip_address,
            "is_alive": is_alive,
            "roundtrip_ms": round_trip_ms
        };
    }));

    // return all results
    return results;
}
