/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import {
    MIN_RESTART_TOKEN_BYTES,
    RESTART_SERVICE_TOKEN_ENV,
    isAuthorizedRestartBearer,
    validateRestartServiceToken,
} from "../../src/restartService";

// Deterministic test secrets sized for the constant-time comparison
// branches: both are at least MIN_RESTART_TOKEN_BYTES long, and the
// wrong-token pair differs only in content (same length).
const TOKEN = "test-restart-secret-0123456789abcdef"; // 35 bytes
const OTHER_SAME_LENGTH = "wrong-restart-secret-0123456789abcdef"; // 35 bytes

describe("validateRestartServiceToken (startup validation)", () => {
    it("returns undefined for an unset secret (feature disabled)", () => {
        expect(validateRestartServiceToken(undefined)).toBeUndefined();
    });

    it("returns undefined for an empty secret (feature disabled)", () => {
        expect(validateRestartServiceToken("")).toBeUndefined();
    });

    it("returns the secret unchanged when it meets the minimum size", () => {
        expect(validateRestartServiceToken(TOKEN)).toBe(TOKEN);
        expect(validateRestartServiceToken("a".repeat(MIN_RESTART_TOKEN_BYTES))).toBe("a".repeat(MIN_RESTART_TOKEN_BYTES));
    });

    it("rejects a whitespace-only secret as a startup configuration error", () => {
        expect(() => validateRestartServiceToken("   ")).toThrow(RESTART_SERVICE_TOKEN_ENV);
        expect(() => validateRestartServiceToken("\t\n ")).toThrow("whitespace-only");
    });

    it("rejects a secret shorter than the minimum size as a startup configuration error", () => {
        expect(() => validateRestartServiceToken("short")).toThrow(`${RESTART_SERVICE_TOKEN_ENV}`);
        expect(() => validateRestartServiceToken("a".repeat(MIN_RESTART_TOKEN_BYTES - 1))).toThrow("at least");
    });

    it("measures the minimum size in bytes, not characters", () => {
        // The euro sign is 3 bytes in UTF-8: 11 of them = 33 bytes (accepted),
        // 10 of them = 30 bytes (rejected) — a character count would pass both
        expect(validateRestartServiceToken("€".repeat(11))).toBe("€".repeat(11));
        expect(() => validateRestartServiceToken("€".repeat(10))).toThrow("at least");
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
