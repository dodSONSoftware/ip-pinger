/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type * as dli from "./interfaces";
import { API_PORT } from "./common";
import { ensureError } from "./systemFunctions";
import { Gauge, Histogram, Counter } from "prom-client";
import type { Server } from "http";
import type { NextFunction } from "express";
import express from "express";
import { setupSwagger } from "./swagger";
import { createRoutes } from "./routes/generalRoutes";
import type { Session } from "net-ping";
const netPing = require("net-ping");
const cors = require("cors");

// ****************************************************************
// ******** Result types for ping operations

// A completed ping is a real network observation (success or failure).
// A cancelled ping was aborted while in flight — by Pinger.close() at
// shutdown, or by the net-ping session failing unexpectedly (whose error
// handler closes the session). net-ping flushes every outstanding callback
// with a plain error when its socket closes. Cancellation is not a network
// failure, so it is a distinct state that the cycle aggregation must skip
// rather than record.
type PingResultInternal =
    | {
        ipAddress: string;
        deviceName: string;
        deviceType: string;
        status: "completed";
        isAlive: boolean;
        roundTripMs: number;
    }
    | {
        ipAddress: string;
        deviceName: string;
        deviceType: string;
        status: "cancelled";
    };

// Why a wait between cycles ended (waitForNextCycle). A fatal net-ping
// session failure is the fourth, exclusive outcome: the wait rejects with
// the fatal error instead of resolving one of these.
type CycleWaitOutcome = "interval" | "config_changed" | "shutdown";

/**
 * The finite set of errorType label values the error counter can carry.
 * Every value corresponds to a condition the net-ping session can actually
 * produce (see getErrorType) — the set deliberately contains no category
 * the library cannot distinguish. Also used when removing a device's series
 * so every label combination is covered without clearing the whole metric.
 */
export const PING_ERROR_TYPES = ["timeout", "host_unreachable", "ttl_exceeded", "other"] as const;
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
    // Set by close() so the run() loop can exit at the next check, and so
    // the wait between cycles can end without sleeping out the interval
    private closed = false;
    // The first unexpected net-ping session error, recorded by the session's
    // "error" handler before it closes the session. Once set, the pinger is
    // no longer operational: the session is closed and cannot be reused, so
    // the run() loop terminates with this error and only a process restart
    // (which recreates the session) can recover.
    private fatal_session_error?: Error;
    // Resolved (with the fatal error, never rejected) when the session fails
    // unexpectedly, so run() can wake from its waits instead of sleeping out
    // the interval. It only ever settles with a value: a session failure
    // while run() is between waits can therefore never become an unhandled
    // promise rejection.
    private fatal_session_error_resolve: (error: Error) => void = () => { };
    private readonly fatal_session_error_promise: Promise<Error> = new Promise<Error>((resolve) => {
        this.fatal_session_error_resolve = resolve;
    });
    // Deferred wake for the wait between cycles, created on demand by
    // waitForNextCycle() and resolved by signalCycleWake(). A signal that
    // arrives while no wait is pending is dropped: the next wait re-checks
    // the closed state on entry and computes its deadline from the live
    // configuration, so a dropped signal can never leave the loop stale.
    private cycle_wake_promise?: Promise<void>;
    private cycle_wake_resolve?: () => void;
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
        this.express.use(express.json());

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
     * pending and applied at the next cycle boundary (immediately after the
     * in-flight cycle's results are processed, before the interval wait),
     * so the current cycle completes under its original device snapshot and
     * no stale in-flight ping can republish the metrics of a device that is
     * being removed. Otherwise the configuration applies immediately and
     * any pending wait between cycles is woken so the next cycle runs under
     * the new configuration without sleeping out the old interval.
     */
    public updateConfig(config: dli.IConfig, config_str: string): void {
        if (this.ping_cycle_in_flight) {
            this.pending_update = { config, config_str };
            this.logger.write_info(this.originator + ".updateConfig", `Ping cycle in flight; configuration update pending until the cycle boundary. ${config.devices.length} devices configured.`);
            return;
        }

        this.applyConfigUpdate(config, config_str);
        this.signalCycleWake();
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
        // stop the run() loop at its next check — and wake it immediately
        // if it is blocked in the wait between cycles, so shutdown does
        // not sleep out the monitoring interval
        this.closed = true;
        this.signalCycleWake();

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

    /**
     * True while the pinger can still perform ping cycles. Once the
     * net-ping session has failed unexpectedly the pinger is permanently
     * not operational: the session is closed and cannot be reused, so the
     * only recovery is a process restart. main() uses this to terminate
     * with a non-zero exit status; /health uses it to stop reporting
     * healthy to the container orchestrator.
     */
    public isOperational(): boolean {
        return this.fatal_session_error === undefined;
    }

    /**
     * True once close() has been requested. This is the caller's signal to
     * stop re-entering run(): a closed pinger's run() resolves immediately
     * (no wait, no cycle), so a loop that keeps calling it spins the event
     * loop on microtasks only — the starved loop then blocks the in-flight
     * close() from completing (its api_server.close() callback is an I/O
     * event that never gets processed) and the process never exits.
     */
    public isClosed(): boolean {
        return this.closed;
    }

    // ****************************************************************
    // ******** IPinger properties

    public async run(): Promise<void> {
        // wait for things to settle-down; the wait is woken early by a
        // configuration change, by close(), or by the net-ping session
        // failing, so none of those has to sleep out the settle delay
        await this.waitForNextCycle(2000);

        // log-it
        this.logger.write_debug(this.originator + ".run", `Pinger Loop Cycle Started.`);

        // loop-it
        while (!this.closed) {
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
                // A ping cancelled by close() was aborted by the application,
                // not failed by the network: skip it entirely so it updates
                // no device state, aggregate count, error counter, or latency
                // observation.
                if (ping_result.status === "cancelled") {
                    continue;
                }

                const { ipAddress, deviceName, deviceType, isAlive, roundTripMs } = ping_result;
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

                // Latency only exists when the ping succeeded. A failed ping
                // carries roundTripMs of 0, and recording it would publish a
                // fake zero-latency observation that corrupts the histogram
                // count/sum (and derived averages). On failure the roundtrip
                // gauge keeps its most recent successful value.
                if (isAlive) {
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

            // Cycle boundary: apply a configuration update that was
            // requested while this cycle was in flight. All of the cycle's
            // pings have completed, so removing the now-orphaned devices'
            // metric series cannot be raced by a stale in-flight result,
            // and the wait below is computed from the new configuration
            // (its new intervalSecs, not the one the cycle ran under).
            if (this.pending_update !== undefined) {
                const { config, config_str } = this.pending_update;
                this.pending_update = undefined;
                this.applyConfigUpdate(config, config_str);
            }

            // The session failed during the cycle: its flush of the in-flight
            // pings was recorded as cancellations above, so stop the loop
            // with the fatal error instead of starting another cycle.
            if (this.fatal_session_error !== undefined) {
                throw this.fatal_session_error;
            }

            // log-it
            this.logger.write_debug(this.originator + ".run", `PINGING COMPLETE. ${upCount} devices up, ${downCount} devices down.`, cycle_start_date);
            this.logger.write_debug(this.originator + ".run", `Cycle duration: ${cycle_duration_ms.toFixed(0)}ms`, cycle_start_date);

            // wait-for-it — the wait ends when the interval elapses, when
            // the configuration changes (the loop starts the next cycle
            // under the new configuration), or when close() is requested
            // (the loop exits); a fatal session failure ends the loop with
            // the error instead of sleeping out the interval
            await this.waitForNextCycle(this.configuration.intervalSecs * 1000, cycle_start_date);
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
        this.ip_pinger.on("error", (error: Error) => {
            const err = ensureError(error);
            const errorMsg = `${err.message}\n${err.stack}`;

            // An unexpected session failure is a fatal application state,
            // not a per-device network failure: record it (the first error
            // wins if the session reports more than one) before closing the
            // session, so the flush of the in-flight pings sees the fatal
            // state and ping_idevice records them as cancellations rather
            // than device-down observations. The wake-up promise makes
            // run() terminate with this error; the application then
            // terminates so the container orchestrator can restart it with
            // a fresh session.
            if (this.fatal_session_error === undefined) {
                this.fatal_session_error = err;
            }
            this.fatal_session_error_resolve(this.fatal_session_error);

            // log-it
            logger.write_error(`${originator}.setup_net_pinger_functions`, errorMsg);

            // close-it
            net_pinger.close();
        });
    }

    /**
     * Returns the deferred promise that ends the current wait between
     * cycles early, creating it on demand. waitForNextCycle calls this
     * synchronously at the start of the wait, so no other code can observe
     * the gap between one wait ending and the next one beginning.
     */
    private getCycleWake(): Promise<void> {
        if (this.cycle_wake_promise === undefined) {
            this.cycle_wake_promise = new Promise<void>((resolve) => {
                this.cycle_wake_resolve = resolve;
            });
        }
        return this.cycle_wake_promise;
    }

    /**
     * Wakes a pending wait between cycles (if any), so a configuration
     * change or a close() request takes effect without sleeping out the
     * interval. A signal with no wait pending is dropped: the next wait
     * re-checks the closed state on entry and computes its deadline from
     * the (already updated) live configuration.
     */
    private signalCycleWake(): void {
        this.cycle_wake_resolve?.();
        this.cycle_wake_promise = undefined;
        this.cycle_wake_resolve = undefined;
    }

    /**
     * Waits between cycles. The wait ends for exactly one of four reasons:
     * - the interval elapses — resolves `"interval"`;
     * - the configuration changes while waiting — resolves
     *   `"config_changed"` (the loop starts the next cycle immediately);
     * - close() is requested — resolves `"shutdown"` (the loop exits);
     * - the net-ping session fails unexpectedly — rejects with the fatal
     *   session error.
     *
     * `intervalMs` is measured from `since` when given, so the deadline
     * stays anchored to the cycle start instead of drifting by the cycle's
     * own duration.
     */
    private async waitForNextCycle(intervalMs: number, since?: Date): Promise<CycleWaitOutcome> {
        // closed may have been set while no wait was pending (e.g. close()
        // during an in-flight cycle): end the wait without sleeping
        if (this.closed) {
            return "shutdown";
        }

        const remainingMs = since !== undefined
            ? intervalMs - (Date.now() - since.getTime())
            : intervalMs;

        // The interval timer is explicit (not sleep()) so a wake that ends
        // the wait early can clear it: an abandoned timer would otherwise
        // keep the process — and the test runner — alive for the
        // remainder of the interval.
        let intervalTimer: ReturnType<typeof setTimeout> | undefined;
        const intervalElapsed = new Promise<CycleWaitOutcome>((resolve) => {
            intervalTimer = setTimeout(() => resolve("interval"), Math.max(0, remainingMs));
        });

        const outcome = await Promise.race([
            intervalElapsed,
            this.getCycleWake().then((): CycleWaitOutcome => (this.closed ? "shutdown" : "config_changed")),
            this.fatal_session_error_promise.then((): "fatal" => "fatal"),
        ]);

        if (intervalTimer !== undefined) {
            clearTimeout(intervalTimer);
        }
        if (outcome === "fatal") {
            throw this.fatal_session_error;
        }
        return outcome;
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
                    // An error that arrives after close() began, or after
                    // the session failed unexpectedly, is the session-close
                    // flush: net-ping invokes every outstanding callback
                    // with a plain error when its socket closes (once the
                    // socket is closed no timeout or response can still
                    // arrive). That is an application-level cancellation —
                    // shutdown or fatal session failure — not a network
                    // failure: resolve it as cancelled so the cycle
                    // neither counts the device down nor records an error.
                    if (this.closed || this.fatal_session_error !== undefined) {
                        logger.write_debug(`${originator}.ping_idevice`, `"${ipAddress}" ping cancelled (shutdown or session failure).`, cycleStartDate);
                        resolve({
                            ipAddress: ipAddress,
                            deviceName: deviceName,
                            deviceType: deviceType,
                            status: "cancelled"
                        });
                        return;
                    }

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
                        status: "completed",
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
                        status: "completed",
                        isAlive: true,
                        roundTripMs
                    });
                }
            });
        });
    }

    /**
     * Classifies the type of ICMP/error encountered during ping.
     *
     * net-ping exposes typed error classes for the conditions it can
     * distinguish, so classification uses them (instanceof) instead of
     * parsing message text. The library reports every destination-
     * unreachable condition as a single DestinationUnreachableError — the
     * ICMP type/code is not surfaced — so host-unreachable and
     * network-unreachable cannot be told apart and are both reported as
     * host_unreachable. Anything the library hands back as a plain Error
     * (socket closed, unknown response type, ...) falls into "other".
     * The result is always one of the finite PING_ERROR_TYPES label values.
     */
    private getErrorType(error: Error): PingErrorType {
        if (error instanceof Error) {
            if (error instanceof netPing.RequestTimedOutError) {
                return "timeout";
            } else if (error instanceof netPing.DestinationUnreachableError) {
                return "host_unreachable";
            } else if (error instanceof netPing.TimeExceededError) {
                return "ttl_exceeded";
            }
        }
        return "other";
    }
}
