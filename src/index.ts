import * as interfaces from "./interfaces";
import * as sysFunc from "./systemFunctions";
import { Logger } from "./Logger";
import { Pinger } from "./Pinger";
import { IConfig, IDevice } from "./interfaces";
import { join } from "path";
import { readFileSync } from "fs";

// ******** global variables

const originator: string = "index";
let config: Map<string, any> | null = new Map<string, any>();
let logger: Logger;
let pinger_dude: interfaces.IPinger;

// ******** local functions

function initialize() {
    // init
    const start_date = new Date();

    // read configurations
    const configuration: IConfig = loadConfig("./config.json");

    // check it
    if (config !== null) {
        console.log(`CONFIGURATION\n\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`);
        console.log(`log_level: ${configuration.log_level}`);
        console.log(`always_log_errors: ${configuration.always_log_errors}`);
        console.log(`prometheus_port: ${configuration.prometheus_port}`);
        console.log(`interval_secs: ${configuration.interval_secs}`);
        configuration.devices.forEach((device) => {
            console.log(`\t ${device.source}: ${device.ip_address}, ${device.device_type}`);
        });
        console.log(`\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n\n`);

        // initialize logger
        logger = new Logger(configuration);

        // log-it
        logger.write_debug(originator + ".initialize", `Starting the Pinger Application...`);

        // init pinger
        pinger_dude = new Pinger(configuration, logger);

        // log-it
        logger.write_info(originator + ".initialize", `Pinger Application initialized.`, start_date);
    } else {
        // TODO ********************************: configuration error
    }
}

function loadConfig(fileName: string): IConfig {
    // read the file (synchronously for simplicity)
    const filePath = join(__dirname, fileName);
    const rawText = readFileSync(filePath, "utf-8");

    // parse the JSON – this gives a plain object
    const data = JSON.parse(rawText) as Record<string, unknown>;

    // helper to assert a property exists and has the expected type
    const get = <T>(obj: Record<string, unknown>, key: string): T => {
        if (!(key in obj)) {
            throw new Error(`Missing config key: ${key}`);
        }
        return obj[key] as T;
    };

    // extract primitive fields
    const log_level = get<string>(data, "log-level");
    const always_log_errors = get<boolean>(data, "always-log-errors");
    const prometheus_port = get<number>(data, "prometheus-port");
    const interval_secs = get<number>(data, "interval-secs");

    // convert the raw devices array to IDevice[]
    const rawDevices = get<any[]>(data, "devices");
    const devices: IDevice[] = rawDevices.map((d) => ({
        source: d.source,
        ip_address: d["ip-address"],
        device_type: d["device-type"],
    }));

    // return the typed config object
    return {
        log_level,
        always_log_errors,
        prometheus_port,
        interval_secs,
        devices,
    };
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
