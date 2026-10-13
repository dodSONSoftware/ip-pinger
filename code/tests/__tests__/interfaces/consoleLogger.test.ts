/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { ConsoleLogger, LogLevel } from "../../../src/interfaces";

// Assert exactly which console sinks a configured ConsoleLogger emits on.
// The behavior contract (minimum-level semantics):
//   None  -> nothing
//   Error -> error
//   Warn  -> error, warn
//   Info  -> error, warn, info
//   Debug -> error, warn, info, debug
function writeAll(logger: ConsoleLogger): void {
    logger.write_error("originator", "error message");
    logger.write_warn("originator", "warn message");
    logger.write_info("originator", "info message");
    logger.write_debug("originator", "debug message");
}

describe("ConsoleLogger minimum-level filtering", () => {
    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        errorSpy = jest.spyOn(console, "error").mockImplementation(() => { });
        warnSpy = jest.spyOn(console, "warn").mockImplementation(() => { });
        logSpy = jest.spyOn(console, "log").mockImplementation(() => { });
        debugSpy = jest.spyOn(console, "debug").mockImplementation(() => { });
    });

    afterEach(() => {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
        logSpy.mockRestore();
        debugSpy.mockRestore();
    });

    it("None emits nothing", () => {
        writeAll(new ConsoleLogger(LogLevel.None));

        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();
    });

    it("Error emits only errors", () => {
        writeAll(new ConsoleLogger(LogLevel.Error));

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();
    });

    it("Warn emits errors and warnings, not info or debug", () => {
        writeAll(new ConsoleLogger(LogLevel.Warn));

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).not.toHaveBeenCalled();
        expect(debugSpy).not.toHaveBeenCalled();
    });

    it("Info emits errors, warnings and info, not debug", () => {
        writeAll(new ConsoleLogger(LogLevel.Info));

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(debugSpy).not.toHaveBeenCalled();
    });

    it("Debug emits every level", () => {
        writeAll(new ConsoleLogger(LogLevel.Debug));

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(debugSpy).toHaveBeenCalledTimes(1);
    });
});
