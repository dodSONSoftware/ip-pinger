/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import * as interfaces from "./interfaces";
import * as sysFunc from "./systemFunctions";
import { Logger } from "./Logger";
import { Pinger } from "./Pinger";
import { loadConfig } from "./common";
import { read_file_json } from "./systemFunctions";
import { APP_VERSION } from "./version";

// ******** global variables

const originator: string = "index";
let logger: Logger;
let pinger_dude: interfaces.IPinger;

// ******** Load package info for logging
const packageJsonPath = "/app/package.json";
const packageData = read_file_json(packageJsonPath);
const appName = packageData?.get("name") ?? "Unknown App";

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
    pinger_dude = new Pinger(configuration, config_str, logger, start_date);

    // Start the HTTP API and await it: a failed bind (e.g. EADDRINUSE)
    // rejects here, propagates out of main(), and the process terminates
    // before the ping loop ever starts.
    await pinger_dude.start();

    // log-it
    logger.write_info(originator + ".initialize", `IP Pinger Application initialized.`, start_date);
}

// ******** graceful shutdown

async function shutdown(signal: string) {
    logger.write_info(originator + ".shutdown", `Received ${signal}, shutting down.`);
    try {
        await pinger_dude.close();
    } catch (error) {
        const err = sysFunc.ensureError(error);
        logger.write_error(originator + ".shutdown", `Error during shutdown: ${err.name}: ${err.message}`);
    } finally {
        process.exit(0);
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
    if (logger) {
        logger.write_error(originator + `.${kind}`, detail);
        // Bounded: an unreachable Loki must not stall the shutdown.
        await logger.flush(LOKI_FLUSH_TIMEOUT_MS);
    } else {
        Logger.write_local_log(interfaces.LogLevel.Error, originator + `.${kind}`, detail);
    }
    setTimeout(() => process.exit(1), 0);
}

process.on("uncaughtException", (err: unknown) => { void terminal_exit("uncaughtException", err); });
process.on("unhandledRejection", (reason: unknown) => { void terminal_exit("unhandledRejection", reason); });

main();
