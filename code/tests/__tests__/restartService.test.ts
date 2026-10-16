/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import {
    isAuthorizedRestartBearer,
    isValidServiceToken,
    resolveServiceTokenState,
    SERVICE_TOKEN_PATTERN,
    validateRestartServiceToken,
} from "../../src/restartService";

// Validation fixtures: a valid service token is pure alphanumeric (the shared
// SERVICE_TOKEN_PATTERN rule); the invalid fixtures trip the length or charset
// bound. The 31/32 pair pins the cutoff.
const VALID_TOKEN = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"; // 32 alphanumeric chars
const VALID_LONG = "testrestartsecret0123456789abcdef"; // 33 alphanumeric chars

// Bearer fixtures: isAuthorizedRestartBearer compares an already-configured
// secret and does not re-validate its charset, so these may carry hyphens;
// the wrong-token pair is the same length so it exercises the constant-time
// compare branch (a length mismatch rejects before the compare).
const TOKEN = "test-restart-secret-0123456789abcdef"; // 35 chars
const OTHER_SAME_LENGTH = "wrong-restart-secret-0123456789abcdef"; // 35 chars

describe("validateRestartServiceToken (startup validation — never throws)", () => {
    it("returns undefined for an unset secret (endpoint disabled)", () => {
        expect(validateRestartServiceToken(undefined)).toBeUndefined();
    });

    it("returns undefined for an empty secret (endpoint disabled)", () => {
        expect(validateRestartServiceToken("")).toBeUndefined();
    });

    it("returns the secret unchanged when it matches the shared validity rule", () => {
        expect(validateRestartServiceToken(VALID_TOKEN)).toBe(VALID_TOKEN);
        expect(validateRestartServiceToken(VALID_LONG)).toBe(VALID_LONG);
        expect(validateRestartServiceToken("a".repeat(32))).toBe("a".repeat(32));
    });

    it("returns undefined (no throw) for a whitespace-only secret", () => {
        expect(validateRestartServiceToken("   ")).toBeUndefined();
        expect(validateRestartServiceToken("\t\n ")).toBeUndefined();
    });

    it("returns undefined (no throw) for a secret shorter than the minimum length", () => {
        expect(validateRestartServiceToken("short")).toBeUndefined();
    });

    it("pins the 31/32 length boundary", () => {
        // One character under the 32 minimum is invalid; exactly 32 is valid.
        expect(validateRestartServiceToken("a".repeat(31))).toBeUndefined();
        expect(validateRestartServiceToken("a".repeat(32))).toBe("a".repeat(32));
    });

    it("rejects non-alphanumeric characters even at/over the minimum length (charset bound)", () => {
        // 48 characters, long enough, but the hyphens are outside A-Z, a-z, 0-9.
        expect(validateRestartServiceToken("a-1".repeat(16))).toBeUndefined();
        // A base64-style / hyphenated value of the same shape as the old
        // byte-length secret is now invalid by charset, not length.
        expect(validateRestartServiceToken("test-restart-secret-0123456789abcdef")).toBeUndefined();
    });

    it("rejects multibyte characters (the charset is ASCII alphanumeric only)", () => {
        expect(validateRestartServiceToken("€".repeat(32))).toBeUndefined();
    });
});

describe("isValidServiceToken (the shared rule for both service tokens)", () => {
    it("is the exact SERVICE_TOKEN_PATTERN predicate", () => {
        expect(SERVICE_TOKEN_PATTERN).toEqual(/^[A-Za-z0-9]{32,}$/);
    });

    it.each([
        ["undefined", undefined, false],
        ["empty", "", false],
        ["31 alphanumeric", "a".repeat(31), false],
        ["32 alphanumeric", "a".repeat(32), true],
        ["64 alphanumeric", VALID_TOKEN + VALID_TOKEN, true],
        ["hyphenated at 32+", "a-1".repeat(16), false],
        ["base64 +/=", "Aa0b1C2d3E4f5G6h7I8j9K0l1M2n3O4p+/", false],
    ])("isValidServiceToken(%s) === %s", (_label, raw, expected) => {
        expect(isValidServiceToken(raw)).toBe(expected);
    });
});

// A spy satisfying the structural TokenStartupLogger surface, used to pin the
// startup-state event names and the never-log-the-value invariant.
function makeSpyLogger() {
    const write_info = jest.fn();
    const write_warn = jest.fn();
    return { logger: { write_info, write_warn }, write_info, write_warn };
}

function allLogCalls(...mocks: jest.Mock[]): string {
    return mocks.map((mock) => JSON.stringify(mock.mock.calls)).join("");
}

describe("resolveServiceTokenState (startup state — warn/info, never throws)", () => {
    it("returns the valid secret and announces config_api_enabled", () => {
        const { logger, write_info, write_warn } = makeSpyLogger();
        expect(resolveServiceTokenState(logger, "config", VALID_TOKEN)).toBe(VALID_TOKEN);
        expect(write_info).toHaveBeenCalledTimes(1);
        expect(String(write_info.mock.calls[0][1])).toContain("config_api_enabled");
        expect(write_warn).not.toHaveBeenCalled();
    });

    it("returns the valid secret and announces restart_endpoint_enabled", () => {
        const { logger, write_info, write_warn } = makeSpyLogger();
        expect(resolveServiceTokenState(logger, "restart", VALID_TOKEN)).toBe(VALID_TOKEN);
        expect(String(write_info.mock.calls[0][1])).toContain("restart_endpoint_enabled");
        expect(write_warn).not.toHaveBeenCalled();
    });

    it.each([
        ["config unset", "config", undefined],
        ["config empty", "config", ""],
        ["restart unset", "restart", undefined],
        ["restart empty", "restart", ""],
    ])("returns undefined and warns %s", (_label, kind, raw) => {
        const { logger, write_info, write_warn } = makeSpyLogger();
        expect(resolveServiceTokenState(logger, kind as "config" | "restart", raw)).toBeUndefined();
        expect(String(write_warn.mock.calls[0][1])).toContain(`${kind}_token_not_set`);
        expect(write_info).not.toHaveBeenCalled();
    });

    it.each([
        ["a 31-character config token", "config", "a".repeat(31)],
        ["a hyphenated config token", "config", "a-1".repeat(16)],
        ["a 31-character restart token", "restart", "a".repeat(31)],
        ["a hyphenated restart token", "restart", "a-1".repeat(16)],
    ])("returns undefined and warns %s (never a startup failure)", (_label, kind, raw) => {
        const { logger, write_info, write_warn } = makeSpyLogger();
        expect(() => resolveServiceTokenState(logger, kind as "config" | "restart", raw)).not.toThrow();
        expect(resolveServiceTokenState(logger, kind as "config" | "restart", raw)).toBeUndefined();
        // The second call re-logs the same event; the first captured it.
        expect(String(write_warn.mock.calls[0][1])).toContain(`${kind}_token_invalid`);
        expect(write_info).not.toHaveBeenCalled();
    });

    it("never logs the token value in any startup event (no-token-in-logs)", () => {
        // A distinctive valid value and a distinctive invalid value must both
        // stay out of every warn/info message, for both tokens.
        const validValue = "Aa0b1C2d3E4f5G6h7I8j9K0l1M2n3O4pZz";
        const invalidValue = "leak-me-please-0000000000000000000";
        for (const kind of ["config", "restart"] as const) {
            const { logger, write_info, write_warn } = makeSpyLogger();
            resolveServiceTokenState(logger, kind, validValue);
            resolveServiceTokenState(logger, kind, invalidValue);
            const serialized = allLogCalls(write_info, write_warn);
            expect(serialized).not.toContain(validValue);
            expect(serialized).not.toContain(invalidValue);
        }
    });
});

describe("isAuthorizedRestartBearer (request authentication)", () => {
    it("authorizes the exact bearer header for the configured secret", () => {
        expect(isAuthorizedRestartBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    });

    it("rejects a missing header", () => {
        expect(isAuthorizedRestartBearer(undefined, TOKEN)).toBe(false);
    });

    it("rejects a wrong token of the same length (constant-time compare branch)", () => {
        expect(isAuthorizedRestartBearer(`Bearer ${OTHER_SAME_LENGTH}`, TOKEN)).toBe(false);
    });

    it("rejects a wrong token of a different length (size-reject branch)", () => {
        expect(isAuthorizedRestartBearer("Bearer short", TOKEN)).toBe(false);
        expect(isAuthorizedRestartBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    });

    it.each([
        ["empty header", ""],
        ["scheme only", "Bearer"],
        ["scheme without space", "Bearer" + TOKEN],
        ["lowercase scheme", `bearer ${TOKEN}`],
        ["double space after scheme", `Bearer  ${TOKEN}`],
        ["trailing space", `Bearer ${TOKEN} `],
        ["two tokens", `Bearer ${TOKEN} extra`],
        ["comma-joined duplicate headers", `Bearer ${TOKEN}, Bearer ${TOKEN}`],
        ["wrong scheme", `Basic ${TOKEN}`],
    ])("rejects a malformed header (%s)", (_label, header) => {
        expect(isAuthorizedRestartBearer(header, TOKEN)).toBe(false);
    });

    it("rejects an empty token after the scheme", () => {
        expect(isAuthorizedRestartBearer("Bearer ", TOKEN)).toBe(false);
    });
});
