/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import * as interfaces from "./interfaces";
import * as sysFunc from "./systemFunctions";
import { Logger } from "./Logger";
import { Pinger } from "./Pinger";
import { loadConfig } from "./common";

// ******** global variables

const originator: string = "index";
let config: Map<string, any> | null = new Map<string, any>();
let logger: Logger;
let pinger_dude: interfaces.IPinger;

// ******** log the boot-up
//console.log(`>>>>>>>> Booting the IP Pinger Application at [${sysFunc.get_timestamp(false)}]`);
Logger.write_local_log(interfaces.LogLevel.Info, "boot", `Booting the IP Pinger Application.`);

// ******** local functions

function initialize() {
    // init
    const start_date = new Date();

    // read configurations
    const [configuration, config_str] = loadConfig();

    // log it
    // Configuration logging removed for production

    // initialize logger
    logger = new Logger(configuration);

    // log-it
    logger.write_debug(originator + ".initialize", `Starting the IP Pinger Application.`);

    // init pinger
    pinger_dude = new Pinger(configuration, config_str, logger);

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
