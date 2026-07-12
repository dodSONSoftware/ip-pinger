/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type * as dli from "./interfaces";
import { get_timestamp, sleep, sleep_from_start } from "./systemFunctions";
import { register, Gauge } from "prom-client";
import type { NextFunction } from "express";
import express from "express";
import bodyParser from "body-parser";
import { setupSwagger } from "./swagger";
import { createRoutes } from "./routes/generalRoutes";
const netPing = require("net-ping");
const cors = require("cors");

export class Pinger implements dli.IPinger {
    // ********
    // ******** private properties

    static thisdude: dli.IPinger;

    private readonly originator: string = "Pinger";
    private config_str: string;
    private configuration: dli.IConfig;
    private readonly logger: dli.ILogger;
    // ----
    private readonly ip_pinger: any;
    private readonly express: any;
    // ----
    private prometheus_Pinger_Up_Gauge: Gauge;
    private prometheus_Pinger_Roundtrip_Gauge: Gauge;

    // ********
    // ******** ctor

    constructor(config: dli.IConfig, config_str: string, logger: dli.ILogger) {
        Pinger.thisdude = this;

        // save parameters
        this.configuration = config;
        this.config_str = config_str;
        this.logger = logger;

        // ******** CREATE PROMETHEUS GAUGES

        // create a gauge for device
        this.prometheus_Pinger_Up_Gauge = new Gauge({
            name: `pinged`,
            help: "This indicator (boolean) shows whether a device has responded, or not, to a ping request.",
            labelNames: ["ip_address", "device_name", "device_type"],
        });

        // create a gauge for device
        this.prometheus_Pinger_Roundtrip_Gauge = new Gauge({
            name: `pinged_roundtrip_ms`,
            help: "This indicator (numeric) shows the roundtrip in milliseconds.",
            labelNames: ["ip_address", "device_name", "device_type"],
        });

        // ******** SETUP EXPRESS

        // init
        this.express = express();

        // create endpoint for Prometheus to scrape metrics
        this.express.get("/metrics", async (req: any, res: any) => {
            res.set("Content-Type", register.contentType);
            res.end(await register.metrics());
        });

        // ******** SETUP MIDDLEWARE

        // add CORS
        this.express.use(cors());
        this.express.use(bodyParser.json());

        // add a simple request logger
        this.express.use((req: Request, res: Response, next: NextFunction) => {
            this.logger.write_debug(this.originator, `${req.method} ${req.url}`);
            next();
        });

        // ******** SETUP ROUTES

        createRoutes(this.express, this.config_str, this, this.logger);

        // ******** SETUP SWAGGER

        setupSwagger(this.express);

        // start the express server on prometheus port
        const promServer = this.express.listen(this.configuration.prometheus_port, () => {
            // log-it
            this.logger.write_info(this.originator + ".ctor", `Express Server, for Prometheus, is running at http://localhost:${this.configuration.prometheus_port}`);
            this.logger.write_info(this.originator + ".ctor", `Prometheus metrics can be found at http://localhost:${this.configuration.prometheus_port}/metrics`);
        });

        promServer.on('error', (err: Error) => {
            this.logger.write_error(this.originator + ".ctor", `Prometheus server error: ${err.message}`);
        });

        // Also listen on API port for HTTP API endpoints
        const apiServer = this.express.listen(this.configuration.api_port, () => {
            this.logger.write_info(this.originator + ".ctor", `API Server is running at http://localhost:${this.configuration.api_port}`);
        });

        apiServer.on('error', (err: Error) => {
            this.logger.write_error(this.originator + ".ctor", `API server error: ${err.message}`);
        });

        // ******** CREATE THE PINGER

        // init the pinger
        const ping_options = {
            networkProtocol: netPing.NetworkProtocol.IPv4,
            packetSize: 16,
            retries: 1,
            sessionId: process.pid % 65535,
            timeout: 2000,
            ttl: 128,
        };
        this.ip_pinger = netPing.createSession(ping_options);

        // setup functions
        this.setup_net_pinger_functions(logger);

        // ******** LOG-IT

        const msg = `Pinger class initialized. ${this.configuration.devices.length} Devices.`;
        logger.write_info(this.originator + ".ctor", msg);
        logger.write_info(this.originator + ".ctor", `Ping Interval Cycle: ${this.configuration.interval_secs} seconds.`);
    } // end-constructor

    // ****************************************************************
    // ******** Public methods for runtime configuration updates

    /**
     * Rebuilds the Prometheus gauges. Call this after configuration changes
     * to ensure metrics only include current devices.
     */
    private rebuildPrometheusGauges(): void {
        // Clear the registry to remove old gauges before recreating them
        register.clear();

        // Recreate gauges with fresh state
        this.prometheus_Pinger_Up_Gauge = new Gauge({
            name: `pinged`,
            help: "This indicator (boolean) shows whether a device has responded, or not, to a ping request.",
            labelNames: ["ip_address", "device_name", "device_type"],
        });

        this.prometheus_Pinger_Roundtrip_Gauge = new Gauge({
            name: `pinged_roundtrip_ms`,
            help: "This indicator (numeric) shows the roundtrip in milliseconds.",
            labelNames: ["ip_address", "device_name", "device_type"],
        });
    }

    /**
     * Updates the configuration at runtime without restarting the service.
     * This allows hot-reloading of the configuration from disk.
     */
    public updateConfig(config: dli.IConfig, config_str: string): void {
        this.configuration = config;
        this.config_str = config_str;
        this.rebuildPrometheusGauges();
        this.logger.write_info(this.originator + ".updateConfig", `Configuration updated. ${this.configuration.devices.length} devices configured.`);
    }

    /**
     * Rebuilds the Prometheus gauges. Public wrapper for IPinger interface.
     */
    public rebuildGauges(): void {
        this.rebuildPrometheusGauges();
    }

    public getLogger(): dli.ILogger {
        return this.logger;
    }

    // ****************************************************************
    // ******** IPinger properties

    public async run(): Promise<void> {
        // wait for things to settle-down
        await sleep(2000);

        // log-it
        this.logger.write_debug(this.originator + ".run", `Pinger Loop Cycle Started.`);

        // loop-it
        while (true) {
            // log-it
            this.logger.write_debug(this.originator + ".run", `PINGING STARTED. Pinging ${this.configuration.devices.length} devices.`);

            // init
            const start_date = new Date();
            const ping_workers = [];

            // process all devices
            for (const device of this.configuration.devices) {
                ping_workers.push(this.ping_idevice(device));
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

                // ******** process prometheus metrics

                // check-it
                if (this.prometheus_Pinger_Up_Gauge) {
                    // set gauge
                    this.prometheus_Pinger_Up_Gauge.set(
                        {
                            ip_address: `${ip_address}`,
                            device_name: `${device_name}`,
                            device_type: `${device_type}`
                        },
                        is_alive
                    );

                    // log-it
                    this.logger.write_debug(this.originator + ".run", `Gauge Set [ is_alive: ${Boolean(is_alive)}, device_name: ${device_name}, device_type: ${device_type}, ip_address: ${ip_address} ].`, start_date);
                } else {
                    // log-it
                    this.logger.write_warn(this.originator + ".run", `Gauge Set; Gauge (Pinger_Gauge) not found: [ ${ip_address}, ${device_name} ]`, start_date);
                }

                // check-it
                if (this.prometheus_Pinger_Roundtrip_Gauge) {
                    // set gauge
                    this.prometheus_Pinger_Roundtrip_Gauge.set(
                        {
                            ip_address: `${ip_address}`,
                            device_name: `${device_name}`,
                            device_type: `${device_type}`
                        },
                        roundtrip_ms
                    );

                    // log-it
                    this.logger.write_debug(this.originator + ".run", `Gauge Set [ roundtrip_ms: ${Number(roundtrip_ms)}, device_name: ${device_name}, ip_address: ${ip_address} ].`, start_date);
                } else {
                    // log-it
                    this.logger.write_warn(this.originator + ".run", `Gauge Set; Gauge (Pinger_Roundtrip_Gauge) not found: [ ${ip_address}, ${device_name} ]`, start_date);
                }
            }

            // log-it
            this.logger.write_debug(this.originator + ".run", `PINGING COMPLETE. ${this.configuration.devices.length} devices pinged.`, start_date);

            // wait-for-it
            await sleep_from_start(this.configuration.interval_secs * 1000, start_date);
        }
    } // end-run

    public async ping_device(ip_address: string): Promise<[boolean, number]> {
        // capture variables
        const logger = this.logger;
        const originator = this.originator;

        return new Promise<[boolean, number]>((resolve) => {
            // ping-it
            this.ip_pinger.pingHost(ip_address, (error: Error | null, target: string, sent: Date, received: Date) => {
                // check
                if (error !== null) {
                    // ping error
                    logger.write_error(`${originator}.ping_device`, `"${ip_address}" Device Error, ${ip_address}, ${error}`);

                    // Resolve with false
                    resolve([false, 0]);

                } else {
                    // calculate ping round-trip
                    const round_trip_ms = received.getTime() - sent.getTime();

                    // ping successful
                    logger.write_debug(`${originator}.ping_device`, `"${ip_address}" Device Alive, ${round_trip_ms}ms.  [target]=${target}`);

                    // Resolve with true
                    resolve([true, round_trip_ms]);
                }
            });
        });
    }

    // ****************************************************************
    // ******** private functions

    private setup_net_pinger_functions(logger: dli.ILogger): void {
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

    private async ping_idevice(device: dli.IDevice): Promise<[string, string, string, boolean, number]> {
        // capture variables
        const logger = this.logger;
        const originator = this.originator;

        return new Promise<[string, string, string, boolean, number]>((resolve) => {
            // ping-it
            this.ip_pinger.pingHost(device.ip_address, (error: Error | null, target: string, sent: Date, received: Date) => {
                // check
                if (error !== null) {
                    // Resolve with false
                    resolve([device.ip_address, device.source, device.device_type, false, 0]);
                } else {
                    // calculate ping round-trip
                    const round_trip_ms = received.getTime() - sent.getTime();

                    // Resolve with true
                    resolve([device.ip_address, device.source, device.device_type, true, round_trip_ms]);
                }
            });
        });
    }
}
