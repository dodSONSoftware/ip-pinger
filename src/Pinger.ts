/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type * as dli from "./interfaces";
import { API_PORT } from "./common";
import { ensureError, sleep, sleep_from_start } from "./systemFunctions";
import { Gauge, Histogram, Counter } from "prom-client";
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

/**
 * The finite set of errorType label values the error counter can carry.
 * Used when removing a device's series so every label combination is
 * covered without clearing the whole metric.
 */
export const PING_ERROR_TYPES = ["timeout", "host_unreachable", "network_unreachable", "ttl_exceeded", "other"] as const;
export type PingErrorType = (typeof PING_ERROR_TYPES)[number];

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
    // HTTP listener port; defaults to the application-wide API_PORT
    private readonly api_port: number;
    // Set by start() once the listener is up; undefined until then
    private api_server?: Server;
    // ----
    // Device-list changes requested while a ping cycle is in flight are
    // held here and applied at the cycle boundary so no in-flight ping can
    // publish metrics for a device that is being removed.
    private pending_update?: { config: dli.IConfig; config_str: string };
    private ping_cycle_in_flight = false;
    // Set by close() so the run() loop can exit at the next check
    private closed = false;
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

    constructor(config: dli.IConfig, config_str: string, logger: dli.ILogger, startDate: Date, port: number = API_PORT) {
        // save parameters
        this.configuration = config;
        this.config_str = config_str;
        this.logger = logger;
        this.api_port = port;

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

        // Device-specific metrics (with labels). These are process-lived:
        // they are created once here and never rebuilt, so reloads can only
        // remove a device's series, never reset the history of others.
        this.createAllDeviceGauges();

        // Baseline the tracked devices from the initial configuration so the
        // first configuration reload can detect devices that were removed.
        this.previousDevices = new Map(
            this.configuration.devices.map((device) =>
                [this.getDeviceKey(device.ipAddress, device.source, device.deviceType), device] as const
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

    // Previous device list, keyed by device key, for tracking removals
    // (baselined in the ctor; kept as IDevice entries because device names
    // may themselves contain the ':' key separator)
    private previousDevices: Map<string, dli.IDevice>;

    // ****************************************************************
    // ******** Public methods for runtime configuration updates

    /**
     * Generates a unique key for a device based on its identifying labels.
     */
    private getDeviceKey(ipAddress: string, deviceName: string, deviceType: string): string {
        return `${ipAddress}:${deviceName}:${deviceType}`;
    }

    /**
     * Removes the Prometheus series that belong to a single device from
     * every per-device metric. Metric objects themselves are process-lived,
     * so the history of all other devices (and of the unlabeled system
     * metrics) is left untouched.
     */
    private removeDeviceMetrics(device: dli.IDevice): void {
        const labels = {
            ipAddress: device.ipAddress,
            deviceName: device.source,
            deviceType: device.deviceType,
        };

        this.prometheus_Pinger_Up_Gauge.remove(labels);
        this.prometheus_Pinger_Roundtrip_Gauge.remove(labels);
        this.prometheus_Pinger_Roundtrip_Histogram.remove(labels);
        this.prometheus_Pinger_Last_Success_Timestamp_Gauge.remove(labels);
        this.prometheus_Pinger_Last_Failure_Timestamp_Gauge.remove(labels);

        // The error counter carries an extra errorType label: remove every
        // known label combination for the device.
        for (const errorType of PING_ERROR_TYPES) {
            this.prometheus_Pinger_Error_Total.remove({ ...labels, errorType });
        }
    }

    /**
     * Removes metrics for devices that are no longer in the configuration.
     * Only the removed devices' label series are deleted; everything else
     * (other devices' gauges, counters, histograms and the system-level
     * metrics) keeps its process-lifetime state.
     */
    private removeRemovedDeviceMetrics(): void {
        const currentDeviceKeys = new Set<string>();
        for (const device of this.configuration.devices) {
            currentDeviceKeys.add(this.getDeviceKey(device.ipAddress, device.source, device.deviceType));
        }

        const removedDevices = [...this.previousDevices.values()].filter(
            (device) => !currentDeviceKeys.has(this.getDeviceKey(device.ipAddress, device.source, device.deviceType))
        );

        this.logger.write_debug(this.originator + ".removeRemovedDeviceMetrics", `Previous keys: ${[...this.previousDevices.keys()].join(", ")}`);
        this.logger.write_debug(this.originator + ".removeRemovedDeviceMetrics", `Current keys: ${[...currentDeviceKeys].join(", ")}`);
        this.logger.write_debug(this.originator + ".removeRemovedDeviceMetrics", `Removed keys: ${removedDevices.map((d) => this.getDeviceKey(d.ipAddress, d.source, d.deviceType)).join(", ")}`);

        for (const device of removedDevices) {
            this.removeDeviceMetrics(device);
        }

        this.previousDevices = new Map(
            this.configuration.devices.map((device) =>
                [this.getDeviceKey(device.ipAddress, device.source, device.deviceType), device] as const
            )
        );

        if (removedDevices.length > 0) {
            this.logger.write_info(this.originator + ".removeRemovedDeviceMetrics", `Removed ${removedDevices.length} device(s). ${this.configuration.devices.length} devices remaining.`);
        } else {
            this.logger.write_debug(this.originator + ".removeRemovedDeviceMetrics", `No devices to remove.`);
        }
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
     * Applies an accepted configuration to the running pinger: swaps the
     * live configuration and removes the metric series of any devices that
     * are no longer configured. Only call this when no ping cycle is in
     * flight (see updateConfig).
     */
    private applyConfigUpdate(config: dli.IConfig, config_str: string): void {
        this.configuration = config;
        this.config_str = config_str;
        this.removeRemovedDeviceMetrics();
        this.logger.write_info(this.originator + ".applyConfigUpdate", `Configuration updated. ${this.configuration.devices.length} devices configured.`);
    }

    /**
     * Updates the configuration at runtime without restarting the service.
     * This allows hot-reloading of the configuration from disk.
     *
     * If a ping cycle is in flight the accepted configuration is held as
     * pending and applied at the next cycle boundary (top of the loop in
     * run()), so the current cycle completes under its original device
     * snapshot and no stale in-flight ping can republish the metrics of a
     * device that is being removed.
     */
    public updateConfig(config: dli.IConfig, config_str: string): void {
        if (this.ping_cycle_in_flight) {
            this.pending_update = { config, config_str };
            this.logger.write_info(this.originator + ".updateConfig", `Ping cycle in flight; configuration update pending until the cycle boundary. ${config.devices.length} devices configured.`);
            return;
        }

        this.applyConfigUpdate(config, config_str);
    }

    /**
     * Starts the HTTP API server and awaits the result.
     * Resolves once the server is listening; rejects if the port cannot be
     * bound (e.g. EADDRINUSE). The caller must treat a rejection as a
     * startup failure: the ping loop must not start, and the failure must
     * propagate to the top-level application boundary.
     */
    public async start(): Promise<void> {
        const port = this.api_port;
        const server = this.express.listen(port);

        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => {
                    server.off("listening", onListening);
                    reject(error);
                };
                const onListening = (): void => {
                    server.off("error", onError);
                    resolve();
                };
                server.once("error", onError);
                server.once("listening", onListening);
            });
        } catch (error) {
            const err = ensureError(error);
            const code = (err as NodeJS.ErrnoException).code;
            this.logger.write_error(
                this.originator + ".start",
                `API server failed to bind on port ${port}: ${err.message}${code ? ` (code: ${code})` : ""}`
            );
            // The listener never started; drop the server so no handle lingers
            server.close();
            throw err;
        }

        this.api_server = server;

        // Log post-start server errors (kept from the previous inline handler)
        this.api_server.on("error", (err: Error) => {
            this.logger.write_error(this.originator + ".start", `API server error: ${err.message}`);
        });

        this.logger.write_info(this.originator + ".start", `API Server is running at http://localhost:${port}`);
        this.logger.write_info(this.originator + ".start", `Prometheus metrics can be found at http://localhost:${port}/metrics`);
    }

    /**
     * Closes the HTTP API server and the net-ping session, giving the
     * application an explicit lifecycle boundary for tests and graceful
     * termination.
     */
    public async close(): Promise<void> {
        // stop the run() loop at its next check
        this.closed = true;

        // close the net-ping session
        this.ip_pinger.close();

        // close the HTTP API server (if it is listening)
        const api_server = this.api_server;
        if (api_server?.listening) {
            await new Promise<void>((resolve) => {
                api_server.close(() => resolve());
                // close idle keep-alive connections so shutdown is prompt
                api_server.closeAllConnections();
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
        while (!this.closed) {
            // Apply a configuration update that was requested while the
            // previous cycle was still in flight. All of that cycle's pings
            // have completed here, so removing the now-orphaned devices'
            // metric series cannot be raced by a stale in-flight result.
            if (this.pending_update !== undefined) {
                const { config, config_str } = this.pending_update;
                this.pending_update = undefined;
                this.applyConfigUpdate(config, config_str);
            }

            this.ping_cycle_in_flight = true;

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

            // All pings of this cycle have completed and their results are
            // fully processed; configuration updates may now apply directly.
            this.ping_cycle_in_flight = false;

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
     * The result is always one of the finite PING_ERROR_TYPES label values.
     */
    private getErrorType(error: Error): PingErrorType {
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
