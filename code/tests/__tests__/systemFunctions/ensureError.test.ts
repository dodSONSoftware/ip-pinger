/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { ensureError } from "../../../src/systemFunctions";

describe("ensureError", () => {
    it("should return an Error object when passed an Error instance", () => {
        const error = new Error("Test error");
        const result = ensureError(error);

        expect(result).toBe(error);
        expect(result.message).toBe("Test error");
    });

    it("should return an Error when passed undefined", () => {
        const result = ensureError(undefined);

        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe("<<< Error is undefined >>>");
    });

    it("should return an Error when passed null", () => {
        const result = ensureError(null);

        expect(result).toBeInstanceOf(Error);
        // JSON.stringify(null) returns "null"
        expect(result.message).toBe("null");
    });

    it("should return an Error when passed a string", () => {
        const result = ensureError("error message");

        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('"error message"');
    });

    it("should return an Error when passed a number", () => {
        const result = ensureError(123);

        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe("123");
    });

    it("should return an Error when passed an object", () => {
        const result = ensureError({ code: 500, message: "Internal Server Error" });

        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('{"code":500,"message":"Internal Server Error"}');
    });

    it("should handle circular references gracefully", () => {
        const obj: Record<string, any> = { name: "test" };
        obj.self = obj; // Circular reference

        const result = ensureError(obj);

        expect(result).toBeInstanceOf(Error);
        // JSON.stringify will throw on circular references, so we should get the fallback message
        expect(result.message).toBe("Unknown Error: error value cannot be converted to a json string.");
    });
});
