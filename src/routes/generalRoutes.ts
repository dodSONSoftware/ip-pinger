/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import express from "express";
import { validateConfig } from "../common";
import { executeCommandLine_Command, write_file } from "../systemFunctions";

// **** HTTP Status Codes

export const OK = 200;
export const InternalServerError = 500;

// **** MIME Types

export const Text = "text/plain";
export const Json = "application/json";

// **** STATIC Information

const aboutInformation = {
    name: "IP Pinger Service",
    version: "0.1.0",
    author: "dodson labs",
    description: "Provides device ping information.",
};

// **** PRIAVTE Variables

var configuration: string;
var config_json: Record<string, any>;

// ******** CREATE Routes

export function createRoutes(app: express.Application, config: string) {
    // **** initialize
    configuration = config;
    config_json = JSON.parse(configuration);

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
            const validData = validateConfig(json_str);
            if (validData.ok) {
                res.status(200).json({ message: "Valid configuration data received" });
                write_file("./config.json", json_str);
            } else {
                res.status(400).json({ message: "Invalid configuration data received", errors: validData.errors });
            }
        } catch (error) {
            res.status(400).json({ message: "Invalid configuration data received" });
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
            const script_str = `docker container restart ${config_json["docker-container-name"]}`;
            console.log(`>>>>>>>> EXECUTING --> ${script_str}`);
            await executeCommandLine_Command(script_str);
            res.status(200).json({ message: `Restarting docker container` });
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
