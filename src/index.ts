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

    // log configuration (using static method since logger isn't fully initialized yet)
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
    }
}

// --------

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main();
