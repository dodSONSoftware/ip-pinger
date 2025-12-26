/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import { IPinger, IDevice, ILogger, IConfig } from "./interfaces";
import { sleep, sleep_from_start } from "./systemFunctions";
import { register, Gauge } from "prom-client";
import express, { NextFunction } from "express";
import bodyParser from "body-parser";
import { setupSwagger } from "./swagger";
import { createRoutes } from "./routes/generalRoutes";
const ping = require("net-ping");

export class Pinger implements IPinger {
    // ********
    // ******** private properties

    private readonly originator: string = "Pinger";
    private readonly config_str: string;
    private readonly configuration: IConfig;
    private readonly logger: ILogger;
    // ----
    private readonly ip_pinger: any;
    private readonly express: any;
    // ----
    private prometheus_Pinger_Up_Gauge: Gauge;
    private prometheus_Pinger_Roundtrip_Gauge: Gauge;

    // ********
    // ******** ctor

    constructor(config: IConfig, config_str: string, logger: ILogger) {
        // save parameters
        this.configuration = config;
        this.config_str = config_str;
        this.logger = logger;

        // ******** CREATE PROMETHEUS GAUGES

        // create a gauge for device
        this.prometheus_Pinger_Up_Gauge = new Gauge({
            name: `pinged`,
            help: "This indicator (boolean) shows whether a device has responded, or not, to a ping request.",
            labelNames: ["ip_address", "device_name", "device_type", "category"],
        });

        // create a gauge for device
        this.prometheus_Pinger_Roundtrip_Gauge = new Gauge({
            name: `pinged_roundtrip_ms`,
            help: "This indicator (numeric) shows the roundtrip in milliseconds.",
            labelNames: ["ip_address", "device_name", "device_type", "category"],
        });

        // ******** SETUP EXPRESS

        // init
        this.express = express();

        // create endpoint for Prometheus to scrape metrics
        this.express.get("/metrics", async (req: any, res: any) => {
            res.set("Content-Type", register.contentType);
            res.end(await register.metrics());
        });

        // starting the express server
        this.express.listen(this.configuration.prometheus_port, () => {
            // log-it
            this.logger.write_info(this.originator + ".ctor", `Express Server, for Prometheus, is running at http://localhost:${this.configuration.prometheus_port}`);
            this.logger.write_info(this.originator + ".ctor", `Prometheus metrics can be found at http://localhost:${this.configuration.prometheus_port}/metrics`);
        });

        // ******** SETUP MIDDLEWARE

        // add CORS
        const cors = require("cors");
        this.express.use(cors());
        this.express.use(bodyParser.json());

        // Simple request logger
        this.express.use((req: Request, res: Response, next: NextFunction) => {
            console.log(`${req.method} ${req.url}`);
            next();
        });

        // ******** SETUP SWAGGER

        createRoutes(this.express, this.config_str);
        setupSwagger(this.express);

        // ******** CREATE THE PINGER

        // init the pinger
        const ping_options = {
            networkProtocol: ping.NetworkProtocol.IPv4,
            packetSize: 16,
            retries: 1,
            sessionId: process.pid % 65535,
            timeout: 2000,
            ttl: 128,
        };
        this.ip_pinger = ping.createSession(ping_options);

        // setup functions
        this.setup_net_pinger_functions(logger);

        // ******** LOG-IT

        const msg = `Pinger class initialized. ${this.configuration.devices.length} Devices.`;
        logger.write_info(this.originator + ".ctor", msg);
        logger.write_info(this.originator + ".ctor", `Ping Interval Cycle: ${this.configuration.interval_secs} seconds.`);
    }

    // ****************************************************************
    // ******** IPinger properties

    public async run(): Promise<void> {
        // wait for things to settle-down
        await sleep(2000);

        // log-it
        this.logger.write_debug(this.originator + ".run", `Pinger Run Started.`);

        // loop-it
        while (true) {
            // init
            const start_date = new Date();
            const ping_workers = [];

            // process all devices
            for (const device of this.configuration.devices) {
                ping_workers.push(this.ping_device(device));
            }

            // wait for all worker to complete
            const all_ping_results = await Promise.all(ping_workers);

            // process results
            for (const ping_result of all_ping_results) {
                // separate results
                const ip_address = String(ping_result[0]);
                const device_name = String(ping_result[1]);
                const device_type = String(ping_result[2]);
                const is_alive = Number(ping_result[3]);
                const roundtrip_ms = Number(ping_result[4]);

                // check-it
                if (this.prometheus_Pinger_Up_Gauge) {
                    // set gauge
                    this.prometheus_Pinger_Up_Gauge.set(
                        {
                            ip_address: `${ip_address}`,
                            device_name: `${device_name}`,
                            device_type: `${device_type}`,
                        },
                        is_alive
                    );

                    // log-it
                    this.logger.write_debug(this.originator + ".run", `Gauge Set [ is_alive: ${Boolean(is_alive)}, device_name: ${device_name}, ip_address: ${ip_address}, device_type: ${device_type} ].`);
                } else {
                    // log-it
                    this.logger.write_warn(this.originator + ".run", `Gauge Set; Gauge (Pinger_Gauge) not found: [ ${ip_address}, ${device_name}, ${device_type} ]`);
                }

                // check-it
                if (this.prometheus_Pinger_Roundtrip_Gauge) {
                    // set gauge
                    this.prometheus_Pinger_Roundtrip_Gauge.set(
                        {
                            ip_address: `${ip_address}`,
                            device_name: `${device_name}`,
                            device_type: `${device_type}`,
                        },
                        roundtrip_ms
                    );

                    // log-it
                    this.logger.write_debug(this.originator + ".run", `Gauge Set [ roundtrip_ms: ${Number(roundtrip_ms)}, device_name: ${device_name}, ip_address: ${ip_address}, device_type: ${device_type} ].`);
                } else {
                    // log-it
                    this.logger.write_warn(this.originator + ".run", `Gauge Set; Gauge (Pinger_Roundtrip_Gauge) not found: [ ${ip_address}, ${device_name}, ${device_type} ]`);
                }
            }

            // wait-for-it
            await sleep_from_start(this.configuration.interval_secs * 1000, start_date);
        }
    }

    // ****************************************************************
    // ******** private functions

    private setup_net_pinger_functions(logger: ILogger): void {
        // init
        const net_pinger = this.ip_pinger;
        const originator = this.originator;

        // close event
        this.ip_pinger.on("close", function () {
            logger.write_debug(`${originator}.setup_net_pinger_functions`, `net_pinger closed.`);
        });

        // log error
        this.ip_pinger.on("error", function (error: any) {
            // log-it
            logger.write_error(`${originator}.setup_net_pinger_functions`, error);

            // close-it
            net_pinger.close();

            // TODO: think about how this will affect the MAIN function
            // TODO: perhaps this should throw an error
        });
    }

    /**
     * pings a device.
     *
     * @param device - The Device.
     * @returns A Tuple[ ip_address, device_name, device_type, is_alive, round_trip_ms ]
     */
    private async ping_device(device: IDevice): Promise<[string, string, string, boolean, number]> {
        // TODO: I think I need to add the histogram here; maybe inject it into this function

        // capture variables
        const logger = this.logger;
        const originator = this.originator;

        return new Promise<[string, string, string, boolean, number]>((resolve) => {
            // log-it
            logger.write_debug(`${originator}.ping_device`, `Pinging Device [${device.source}, ${device.ip_address}, ${device.device_type}]...`);

            // ping-it
            this.ip_pinger.pingHost(device.ip_address, (error: Error | null, target: string, sent: Date, received: Date) => {
                // check
                if (error !== null) {
                    // ping error
                    logger.write_error(`${originator}.ping_device`, `Device Error, ${device.source}, ${device.ip_address}, ${device.device_type}, ${error}`);

                    // Resolve with false
                    resolve([device.ip_address, device.source, device.device_type, false, 0]);
                } else {
                    // calculate ping round-trip
                    const round_trip_ms = received.getTime() - sent.getTime();

                    // ping successful
                    logger.write_debug(`${originator}.ping_device`, `Device Alive, ${device.source}, ${device.ip_address}, ${device.device_type}, ${round_trip_ms}ms.`);

                    // Resolve with true
                    resolve([device.ip_address, device.source, device.device_type, true, round_trip_ms]);
                }
            });
        });
    }
}
