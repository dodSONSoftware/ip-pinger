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

function initialize() {
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

    // log-it
    logger.write_info(originator + ".initialize", `IP Pinger Application initialized.`, start_date);
}

// ******** main function

async function main() {
    // init
    initialize();

    // loop-it
    while (true) {
        try {
            // run the pinger
            await pinger_dude.run();
        } catch (error) {
            // log-it
            const err = sysFunc.ensureError(error);
            logger.write_error(originator + ".main", `${err.name}: ${err.message}`);
        }
    }
}

// --------
main();
