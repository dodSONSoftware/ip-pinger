/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { LogLevel } from "../../../src/interfaces";

describe("LogLevel enum", () => {
    it("should have correct numeric values", () => {
        expect(LogLevel.None).toBe(0);
        expect(LogLevel.Info).toBe(1);
        expect(LogLevel.Warn).toBe(2);
        expect(LogLevel.Error).toBe(3);
        expect(LogLevel.Debug).toBe(4);
    });

    it("should allow accessing names via bracket notation with string literals", () => {
        // With non-const enums, we can access names using string literals
        expect(LogLevel[0]).toBe("None");
        expect(LogLevel[1]).toBe("Info");
        expect(LogLevel[2]).toBe("Warn");
        expect(LogLevel[3]).toBe("Error");
        expect(LogLevel[4]).toBe("Debug");
    });
});
