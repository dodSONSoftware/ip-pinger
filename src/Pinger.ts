/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type * as dli from "./interfaces";
import { sleep, sleep_from_start } from "./systemFunctions";
import { register, Gauge, Histogram, Counter } from "prom-client";
import type { Server } from "http";
import type { NextFunction } from "express";
import express from "express";
import bodyParser from "body-parser";
import { setupSwagger } from "./swagger";
import { createRoutes } from "./routes/generalRoutes";
import type { Session } from "net-ping";
const netPing = require("net-ping");
const cors = require("cors");

// ****************************************************************
// ******** Result types for ping operations

interface PingResultInternal {
    ipAddress: string;
    deviceName: string;
    deviceType: string;
    isAlive: boolean;
    roundTripMs: number;
}

export class Pinger implements dli.IPinger {
    // ********
    // ******** private properties

    private readonly originator: string = "Pinger";
    private config_str: string;
    private configuration: dli.IConfig;
    private readonly logger: dli.ILogger;
    // ----
    private readonly ip_pinger: Session;
    private readonly express: express.Application;
    private api_server: Server;
    // ----
    private prometheus_Pinger_Up_Gauge!: Gauge;
    private prometheus_Pinger_Roundtrip_Gauge!: Gauge;
    private prometheus_Pinger_Roundtrip_Histogram!: Histogram;
    // Additional metrics
    private prometheus_Pinger_Cycle_Duration_Histogram: Histogram;
    private prometheus_Pinger_Devices_Up_Gauge: Gauge;
    private prometheus_Pinger_Devices_Down_Gauge: Gauge;
    private prometheus_Pinger_Last_Success_Timestamp_Gauge!: Gauge;
    private prometheus_Pinger_Last_Failure_Timestamp_Gauge!: Gauge;
    private prometheus_Pinger_Error_Total!: Counter;

    // ********
    // ******** ctor

    constructor(config: dli.IConfig, config_str: string, logger: dli.ILogger, startDate: Date) {
        // save parameters
        this.configuration = config;
        this.config_str = config_str;
        this.logger = logger;

        // ******** CREATE PROMETHEUS GAUGES

        // System-level gauges (no labels, persist across config reloads)
        this.prometheus_Pinger_Cycle_Duration_Histogram = new Histogram({
            name: `pinger_cycle_duration_seconds`,
            help: "Duration of complete ping cycles in seconds.",
            buckets: [1, 5, 10, 30, 60, 120, 300],
        });

        this.prometheus_Pinger_Devices_Up_Gauge = new Gauge({
            name: `pinger_devices_up`,
            help: "Number of devices currently reachable.",
        });

        this.prometheus_Pinger_Devices_Down_Gauge = new Gauge({
            name: `pinger_devices_down`,
            help: "Number of devices currently unreachable.",
        });

        // Device-specific gauges (with labels, recreated on config reload)
        this.createAllDeviceGauges();

        // Baseline the tracked device keys from the initial configuration so the
        // first configuration reload can detect devices that were removed.
        this.previousDeviceKeys = new Set(
            this.configuration.devices.map((device) =>
                this.getDeviceKey(device.ipAddress, device.source, device.deviceType)
            )
        );

        // ******** SETUP EXPRESS

        // init
        this.express = express();

        // ******** SETUP MIDDLEWARE

        // add CORS
        this.express.use(cors());
        this.express.use(bodyParser.json());

        // add a simple request logger
        this.express.use((req: express.Request, res: express.Response, next: NextFunction) => {
            this.logger.write_debug(this.originator, `${req.method} ${req.url}`);
            next();
        });

        // ******** SETUP ROUTES

        createRoutes(this.express, this.configuration, this.config_str, this, this.logger, startDate);

        // ******** SETUP SWAGGER

        setupSwagger(this.express as express.Express);

        // Start the express server on API port for all endpoints including metrics
        this.api_server = this.express.listen(this.configuration.apiPort, () => {
            this.logger.write_info(this.originator + ".ctor", `API Server is running at http://localhost:${this.configuration.apiPort}`);
            this.logger.write_info(this.originator + ".ctor", `Prometheus metrics can be found at http://localhost:${this.configuration.apiPort}/metrics`);
        });

        this.api_server.on('error', (err: Error) => {
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
        logger.write_info(this.originator + ".ctor", `Ping Interval Cycle: ${this.configuration.intervalSecs} seconds.`);
    } // end-constructor

    // Store previous device identifiers for tracking changes (baselined in the ctor)
    private previousDeviceKeys: Set<string>;

    // ****************************************************************
    // ******** Public methods for runtime configuration updates

    /**
     * Generates a unique key for a device based on its identifying labels.
     */
    private getDeviceKey(ipAddress: string, deviceName: string, deviceType: string): string {
        return `${ipAddress}:${deviceName}:${deviceType}`;
    }

    /**
     * Removes metrics for devices that are no longer in the configuration.
     * Call this after configuration changes to clean up orphaned metrics.
     *
     * Uses register.clear() followed by re-registering system-level gauges
     * and recreating device-specific gauges.
     * This is safe to do during config reload (not every ping cycle).
     */
    private cleanupOrphanedGauges(currentDeviceKeys: Set<string>): void {
        // Find keys that were removed
        const removedKeys = [...this.previousDeviceKeys].filter(key => !currentDeviceKeys.has(key));

        this.logger.write_debug(this.originator + ".cleanupOrphanedGauges", `Previous keys: ${[...this.previousDeviceKeys].join(", ")}`);
        this.logger.write_debug(this.originator + ".cleanupOrphanedGauges", `Current keys: ${[...currentDeviceKeys].join(", ")}`);
        this.logger.write_debug(this.originator + ".cleanupOrphanedGauges", `Removed keys: ${removedKeys.join(", ")}`);

        if (removedKeys.length === 0) {
            this.logger.write_debug(this.originator + ".cleanupOrphanedGauges", `No devices to remove.`);
            return;
        }

        this.logger.write_info(this.originator + ".cleanupOrphanedGauges", `Removing ${removedKeys.length} orphaned device(s).`);

        // Clear all metrics
        // This ensures removed devices' metrics are completely purged
        register.clear();

        // Re-register system-level gauges (these don't have labels, so they persist across reloads)
        this.prometheus_Pinger_Cycle_Duration_Histogram = new Histogram({
            name: `pinger_cycle_duration_seconds`,
            help: "Duration of complete ping cycles in seconds.",
            buckets: [1, 5, 10, 30, 60, 120, 300],
        });

        this.prometheus_Pinger_Devices_Up_Gauge = new Gauge({
            name: `pinger_devices_up`,
            help: "Number of devices currently reachable.",
        });

        this.prometheus_Pinger_Devices_Down_Gauge = new Gauge({
            name: `pinger_devices_down`,
            help: "Number of devices currently unreachable.",
        });

        // Re-create gauges for all current devices
        this.createAllDeviceGauges();

        this.logger.write_info(this.originator + ".cleanupOrphanedGauges", `Cleanup complete. ${this.configuration.devices.length} devices remaining.`);
    }

    /**
     * Creates all device-specific Prometheus gauges.
     */
    private createAllDeviceGauges(): void {
        // Create a gauge for device status
        this.prometheus_Pinger_Up_Gauge = new Gauge({
            name: `pinged`,
            help: "This indicator (boolean) shows whether a device has responded, or not, to a ping request.",
            labelNames: ["ipAddress", "deviceName", "deviceType"],
        });

        // Create a gauge for device round-trip time
        this.prometheus_Pinger_Roundtrip_Gauge = new Gauge({
            name: `pinged_roundtrip_ms`,
            help: "This indicator (numeric) shows the roundtrip in milliseconds.",
            labelNames: ["ipAddress", "deviceName", "deviceType"],
        });

        // Create a histogram for roundtrip distribution
        this.prometheus_Pinger_Roundtrip_Histogram = new Histogram({
            name: `pinged_roundtrip_seconds`,
            help: "Histogram of ping round-trip times in seconds.",
            labelNames: ["ipAddress", "deviceName", "deviceType"],
            buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
        });

        // Create gauges for last success/failure timestamps
        this.prometheus_Pinger_Last_Success_Timestamp_Gauge = new Gauge({
            name: `pinged_last_success_timestamp`,
            help: "Unix timestamp of the last successful ping for each device.",
            labelNames: ["ipAddress", "deviceName", "deviceType"],
        });

        this.prometheus_Pinger_Last_Failure_Timestamp_Gauge = new Gauge({
            name: `pinged_last_failure_timestamp`,
            help: "Unix timestamp of the last failed ping for each device.",
            labelNames: ["ipAddress", "deviceName", "deviceType"],
        });

        // Create counter for ping errors
        this.prometheus_Pinger_Error_Total = new Counter({
            name: `pinged_errors_total`,
            help: "Total count of ping errors by device.",
            labelNames: ["ipAddress", "deviceName", "deviceType", "errorType"],
        });
    }

    /**
     * Rebuilds the Prometheus gauges for device-specific metrics.
     * Call this after configuration changes to ensure metrics only include current devices.
     */
    private rebuildPrometheusGauges(): void {
        // Get current device keys for tracking
        const currentDeviceKeys = new Set<string>();
        for (const device of this.configuration.devices) {
            const key = this.getDeviceKey(device.ipAddress, device.source, device.deviceType);
            currentDeviceKeys.add(key);
        }

        // Clean up gauges for removed devices before updating tracked keys
        this.cleanupOrphanedGauges(currentDeviceKeys);

        // Update previous device keys for next comparison
        this.previousDeviceKeys = currentDeviceKeys;

        this.logger.write_info(this.originator + ".rebuildPrometheusGauges", `Rebuilt gauges for ${this.configuration.devices.length} devices.`);
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
     * Closes the HTTP API server and the net-ping session, giving the
     * application an explicit lifecycle boundary for tests and graceful
     * termination.
     */
    public async close(): Promise<void> {
        // close the net-ping session
        this.ip_pinger.close();

        // close the HTTP API server (if it is listening)
        if (this.api_server?.listening) {
            await new Promise<void>((resolve) => {
                this.api_server.close(() => resolve());
                // close idle keep-alive connections so shutdown is prompt
                this.api_server.closeAllConnections();
            });
        }

        this.logger.write_info(this.originator + ".close", `Pinger closed.`);
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
            const cycle_start_date = new Date();
            const ping_workers = [];
            let upCount = 0;
            let downCount = 0;

            // process all devices
            for (const device of this.configuration.devices) {
                ping_workers.push(this.ping_idevice(device, cycle_start_date));
            }

            // wait for all workers to complete
            const all_ping_results = await Promise.all(ping_workers);

            // process results and count up/down devices
            for (const ping_result of all_ping_results) {
                const { ipAddress, deviceName, deviceType, isAlive, roundTripMs }: PingResultInternal = ping_result;
                const isAliveNum = isAlive ? 1 : 0;

                if (isAlive) {
                    upCount++;
                } else {
                    downCount++;
                }

                // Update per-device status gauge
                if (this.prometheus_Pinger_Up_Gauge) {
                    this.prometheus_Pinger_Up_Gauge.set(
                        { ipAddress: `${ipAddress}`, deviceName: `${deviceName}`, deviceType: `${deviceType}` },
                        isAliveNum
                    );
                }

                // Ensure roundTripMs is an integer (no decimal places)
                const roundTripMsInt = Math.trunc(roundTripMs);

                // Update per-device roundtrip gauge
                if (this.prometheus_Pinger_Roundtrip_Gauge) {
                    this.prometheus_Pinger_Roundtrip_Gauge.set(
                        { ipAddress: `${ipAddress}`, deviceName: `${deviceName}`, deviceType: `${deviceType}` },
                        roundTripMsInt
                    );
                }

                // Update per-device roundtrip histogram
                const roundTripSeconds = roundTripMsInt / 1000;
                if (this.prometheus_Pinger_Roundtrip_Histogram) {
                    this.prometheus_Pinger_Roundtrip_Histogram.observe(
                        { ipAddress: `${ipAddress}`, deviceName: `${deviceName}`, deviceType: `${deviceType}` },
                        roundTripSeconds
                    );
                }

                // Update timestamps based on result
                const nowTimestamp = Math.floor(new Date().getTime() / 1000); // Unix timestamp in seconds
                if (isAlive) {
                    if (this.prometheus_Pinger_Last_Success_Timestamp_Gauge) {
                        this.prometheus_Pinger_Last_Success_Timestamp_Gauge.set(
                            { ipAddress: `${ipAddress}`, deviceName: `${deviceName}`, deviceType: `${deviceType}` },
                            nowTimestamp
                        );
                    }
                } else {
                    if (this.prometheus_Pinger_Last_Failure_Timestamp_Gauge) {
                        this.prometheus_Pinger_Last_Failure_Timestamp_Gauge.set(
                            { ipAddress: `${ipAddress}`, deviceName: `${deviceName}`, deviceType: `${deviceType}` },
                            nowTimestamp
                        );
                    }
                }
            }

            // Update aggregate device counts
            if (this.prometheus_Pinger_Devices_Up_Gauge) {
                this.prometheus_Pinger_Devices_Up_Gauge.set(upCount);
            }
            if (this.prometheus_Pinger_Devices_Down_Gauge) {
                this.prometheus_Pinger_Devices_Down_Gauge.set(downCount);
            }

            // Record cycle duration (ensure integer milliseconds)
            const cycle_end_date = new Date();
            const cycle_duration_ms = Math.trunc(cycle_end_date.getTime() - cycle_start_date.getTime());
            const cycle_duration_seconds = cycle_duration_ms / 1000;
            if (this.prometheus_Pinger_Cycle_Duration_Histogram) {
                this.prometheus_Pinger_Cycle_Duration_Histogram.observe(cycle_duration_seconds);
            }

            // log-it
            this.logger.write_debug(this.originator + ".run", `PINGING COMPLETE. ${upCount} devices up, ${downCount} devices down.`, cycle_start_date);
            this.logger.write_debug(this.originator + ".run", `Cycle duration: ${cycle_duration_ms.toFixed(0)}ms`, cycle_start_date);

            // wait-for-it
            await sleep_from_start(this.configuration.intervalSecs * 1000, cycle_start_date);
        }
    } // end-run

    public async ping_device(ipAddress: string): Promise<[boolean, number]> {
        // capture variables
        const logger = this.logger;
        const originator = this.originator;

        return new Promise<[boolean, number]>((resolve) => {
            // ping-it
            this.ip_pinger.pingHost(ipAddress, (error: Error | null, target: string, sent: Date, received: Date) => {
                // check
                if (error !== null) {
                    // ping error
                    logger.write_error(`${originator}.ping_device`, `"${ipAddress}" Device Error, ${ipAddress}, ${error}`);

                    // Resolve with false
                    resolve([false, 0]);

                } else {
                    // calculate ping round-trip (ensure integer milliseconds)
                    const roundTripMs = Math.trunc(received.getTime() - sent.getTime());

                    // ping successful
                    logger.write_debug(`${originator}.ping_device`, `"${ipAddress}" Device Alive, ${roundTripMs}ms.  [target]=${target}`);

                    // Resolve with true
                    resolve([true, roundTripMs]);
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
        this.ip_pinger.on("error", function (error: Error) {
            // log-it
            const errorMsg = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
            logger.write_error(`${originator}.setup_net_pinger_functions`, errorMsg);

            // close-it
            net_pinger.close();

            // TODO: think about how this will affect the MAIN function
            // TODO: perhaps this should throw an error
        });
    }

    private async ping_idevice(device: dli.IDevice, cycleStartDate: Date): Promise<PingResultInternal> {
        // capture variables
        const logger = this.logger;
        const originator = this.originator;
        const ipAddress = device.ipAddress;
        const deviceName = device.source;
        const deviceType = device.deviceType;

        return new Promise<PingResultInternal>((resolve) => {
            // ping-it
            this.ip_pinger.pingHost(ipAddress, (error: Error | null, target: string, sent: Date, received: Date) => {
                // check
                if (error !== null) {
                    // Increment error counter
                    const errorType = this.getErrorType(error);
                    if (this.prometheus_Pinger_Error_Total) {
                        this.prometheus_Pinger_Error_Total.inc({
                            ipAddress: `${ipAddress}`,
                            deviceName: `${deviceName}`,
                            deviceType: `${deviceType}`,
                            errorType: errorType,
                        });
                    }

                    // log error
                    logger.write_error(`${originator}.ping_idevice`, `"${ipAddress}" Device Error (${errorType}), ${error}`);

                    // Resolve with false
                    resolve({
                        ipAddress: ipAddress,
                        deviceName: deviceName,
                        deviceType: deviceType,
                        isAlive: false,
                        roundTripMs: 0
                    });
                } else {
                    // calculate ping round-trip (ensure integer milliseconds)
                    const roundTripMs = Math.trunc(received.getTime() - sent.getTime());

                    // ping successful
                    logger.write_debug(`${originator}.ping_idevice`, `"${ipAddress}" Device Alive, ${roundTripMs}ms.`, cycleStartDate);

                    // Resolve with true
                    resolve({
                        ipAddress: ipAddress,
                        deviceName: deviceName,
                        deviceType: deviceType,
                        isAlive: true,
                        roundTripMs
                    });
                }
            });
        });
    }

    /**
     * Classifies the type of ICMP/error encountered during ping.
     */
    private getErrorType(error: Error): string {
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes("timeout") || msg.includes("timed out")) {
                return "timeout";
            } else if (msg.includes("unreachable") || msg.includes("no route")) {
                return "host_unreachable";
            } else if (msg.includes("network")) {
                return "network_unreachable";
            } else if (msg.includes("ttl") || msg.includes("time exceeded")) {
                return "ttl_exceeded";
            }
        }
        return "other";
    }
}
