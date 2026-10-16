/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import * as interfaces from "./interfaces";
import * as sysFunc from "./systemFunctions";
import { Logger } from "./Logger";
import { Pinger } from "./Pinger";
import { loadConfig } from "./common";
import { RESTART_SERVICE_TOKEN_ENV, validateRestartServiceToken } from "./restartService";
import { read_file_json } from "./systemFunctions";
import { APP_VERSION } from "./version";
import { collectDefaultMetrics } from "prom-client";
import path from "path";

// ******** global variables

const originator: string = "index";
// Seeded with a console-only bootstrap logger so the signal handlers and
// the terminal error boundary can log — and a requested shutdown can exit
// cleanly — even when a signal arrives before initialize() has loaded the
// configuration and constructed the full Logger.
let logger: interfaces.ILogger = new interfaces.ConsoleLogger(interfaces.LogLevel.Error);
let pinger_dude: interfaces.IPinger;

// ******** Load package info for logging
// Resolved relative to this file instead of hard-coded to the container
// layout: __dirname is dist/ (or src/ under ts-node), so the join finds
// code/package.json locally and /app/package.json in the image, where the
// code lives at /app/dist. Without the match the boot log reports
// "Unknown App" for the service name.
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageData = read_file_json(packageJsonPath);
const appName = packageData?.get("name") ?? "Unknown App";

// Standard Node.js process metrics (uptime, heap, event-loop lag, GC,
// ...). The service's own metrics describe the devices and the ping loop;
// they say nothing about the process hosting them, so the prom-client
// default set is registered on the same /metrics endpoint.
collectDefaultMetrics();

// ******** log the boot-up
Logger.write_local_log(interfaces.LogLevel.Info, "boot", `Booting ${appName} v${APP_VERSION}.`);

// ******** local functions

async function initialize() {
    // init
    const start_date = new Date();

    // Create a console logger first for bootstrap errors
    const bootstrapLogger = new interfaces.ConsoleLogger(interfaces.LogLevel.Error);

    // read configurations - pass bootstrap logger so errors are logged
    const [configuration, config_str] = loadConfig(bootstrapLogger);

    // initialize logger first
    logger = new Logger(configuration);

    // The logger is already initialized above; this static call is
    // intentional: the full configuration dump is console-only (docker
    // logs), while Loki receives the structured lifecycle lines below.
    Logger.write_local_log(
        interfaces.LogLevel.Info,
        originator + ".initialize",
        `Configuration loaded:\n${config_str}`
    );

    // log-it
    logger.write_debug(originator + ".initialize", `Starting the IP Pinger Application.`);

    // init pinger
    // The restart endpoint's secret is read and validated exactly once at
    // startup: an unset RESTART_SERVICE_TOKEN leaves POST /restart-service
    // disabled (503), and a present-but-weak one fails the boot here
    // instead of arming a guessable restart button. The injected callback
    // reuses the existing guarded shutdown (its shutdown_in_progress guard
    // also dedupes a restart racing a signal): the route never signals or
    // exits the process itself, and the container's restart policy brings
    // the process back up.
    const restart_token = validateRestartServiceToken(process.env[RESTART_SERVICE_TOKEN_ENV]);
    pinger_dude = new Pinger(configuration, config_str, logger, start_date, undefined, {
        token: restart_token,
        requestRestart: () => void shutdown("API restart request"),
    });

    // Start the HTTP API and await it: a failed bind (e.g. EADDRINUSE)
    // rejects here, propagates out of main(), and the process terminates
    // before the ping loop ever starts.
    await pinger_dude.start();

    // log-it
    logger.write_info(originator + ".initialize", `IP Pinger Application initialized.`, start_date);
}

// ******** graceful shutdown

// Guards against a second signal (or a signal racing a terminal exit)
// re-entering shutdown while the first is still running: a double close()
// and double process.exit() in flight would make the shutdown sequence
// unexplainable in the logs, so the duplicate is logged and dropped
let shutdown_in_progress = false;
async function shutdown(signal: string) {
    if (shutdown_in_progress) {
        logger.write_warn(originator + ".shutdown", `Received ${signal} while shutdown is already in progress; ignoring.`);
        return;
    }
    shutdown_in_progress = true;
    logger.write_info(originator + ".shutdown", `Received ${signal}, shutting down.`);
    try {
        await pinger_dude.close();
    } catch (error) {
        const err = sysFunc.ensureError(error);
        logger.write_error(originator + ".shutdown", `Error during shutdown: ${err.name}: ${err.message}`);
    } finally {
        // Flush before the exit so the shutdown lines and the tail of the
        // final cycle reach Loki instead of dying in the 5 s batch window
        // (console is unaffected — the console transport is synchronous).
        await flush_loki();
        // A terminal error accepted while we were shutting down owns the
        // exit: the process is doomed and exits 1 via terminal_exit's
        // timer, and exiting 0 here would misreport a crash as a clean stop.
        if (!terminating) {
            process.exit(0);
        }
    }
}

// ******** main function

async function main() {
    // init
    await initialize();

    // loop-it
    while (true) {
        try {
            // run the pinger
            await pinger_dude.run();
        } catch (error) {
            // log-it
            const err = sysFunc.ensureError(error);
            logger.write_error(originator + ".main", `${err.name}: ${err.message}`);

            // A failed ping engine is a terminal application state: the
            // net-ping session is closed and cannot be reused, so calling
            // run() again on the same instance cannot recover. Clean up
            // and exit non-zero so the container orchestrator
            // (restart: unless-stopped) recreates the process with a
            // fresh session.
            if (!pinger_dude.isOperational()) {
                logger.write_error(originator + ".main", `Ping engine failed permanently; terminating the process for a container-managed restart.`);
                try {
                    await pinger_dude.close();
                } catch (close_error) {
                    const close_err = sysFunc.ensureError(close_error);
                    logger.write_error(originator + ".main", `Error during shutdown: ${close_err.name}: ${close_err.message}`);
                }
                // Flush like the signal shutdown: without it, the engine
                // failure lines and "Pinger closed." die in winston-loki's
                // 5 s batch window. A concurrent shutdown() can exit 0
                // first if its flush resolves first; that race predates this
                // change and is cosmetic — restart: unless-stopped restarts
                // on either exit code.
                await flush_loki();
                process.exit(1);
            }
        }

        // run() resolves normally only when close() was requested (a fatal
        // session error rejects instead, and the branch above already
        // exited). A closed pinger's run() returns immediately — no wait,
        // no cycle — so re-entering it here would spin the event loop on
        // microtasks only: the starved loop never reaches the poll phase,
        // the in-flight close() (awaiting its api_server.close() I/O
        // callback) never completes, and shutdown's process.exit(0) is
        // never reached. Break so close() can finish and the process exit.
        if (pinger_dude.isClosed()) {
            break;
        }
    }
}

// --------

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Terminal error boundary: anything reaching these handlers escaped every
// in-app try/catch. It is logged (instance logger -> console + Loki when the
// logger exists; console-only static writer during the pre-bootstrap window
// before the Logger is constructed), the Loki transport is then flushed
// explicitly, and the process exits non-zero so the container orchestrator
// restarts it.
//
// The flush must be explicit: winston-loki batches entries and holds them
// for its 5s default send interval, so a short sleep + process.exit would
// kill the process before the terminal entry was ever sent. The exit timer
// below is deliberately NOT unref'd, so it keeps the event loop alive and a
// naturally draining loop cannot exit 0 ahead of the forced non-zero exit.
const LOKI_FLUSH_TIMEOUT_MS = 3000;

// Bounded Loki flush shared by every exit path: the graceful signal
// shutdown, the fatal ping-engine termination, and the terminal error
// boundary. winston-loki holds entries for its 5 s send interval, so an
// exit without an explicit flush discards the still-batched tail — which
// on a shutdown always includes the shutdown lines themselves, since they
// are logged microseconds before the exit. The wait is bounded by
// LOKI_FLUSH_TIMEOUT_MS so an unreachable Loki cannot push the stop past
// Docker's 10 s grace period. The bootstrap ConsoleLogger (a signal that
// arrives before initialize() built the full Logger) has no Loki transport
// to flush, so the guard makes that case a no-op; Logger.flush is
// effectively total and never throws, so an exit path can await it in a
// finally block without its own try/catch.
async function flush_loki(): Promise<void> {
    if (logger instanceof Logger) {
        await logger.flush(LOKI_FLUSH_TIMEOUT_MS);
    }
}

// Re-entrancy guard: after the first terminal error the process is already
// doomed but the event loop still runs for the flush window — any further
// terminal errors in that window are noise, so they are ignored rather than
// logged as duplicate entries with a second exit timer.
let terminating = false;
async function terminal_exit(kind: string, err: unknown): Promise<void> {
    if (terminating) {
        return;
    }
    terminating = true;
    const e = sysFunc.ensureError(err);
    const detail = `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}`;
    // logger is always set: before the configuration loads it is the
    // console-only bootstrap logger; the full Logger replaces it once
    // initialize() succeeds.
    logger.write_error(originator + `.${kind}`, detail);
    // Bounded flush, shared with the other exit paths (see flush_loki): an
    // unreachable Loki must not stall the exit.
    await flush_loki();
    setTimeout(() => process.exit(1), 0);
}

process.on("uncaughtException", (err: unknown) => { void terminal_exit("uncaughtException", err); });
process.on("unhandledRejection", (reason: unknown) => { void terminal_exit("unhandledRejection", reason); });

main();
