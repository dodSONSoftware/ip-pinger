/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { timingSafeEqual } from "crypto";

// Name of the environment variable holding the /restart-service bearer
// secret. Read and validated exactly once at startup by the composition
// root (index.ts). Two-state model (shared with the config token): unset,
// empty, or set-but-invalid disables the endpoint and the service boots
// with a startup warning; only a valid token enables it.
export const RESTART_SERVICE_TOKEN_ENV = "RESTART_SERVICE_TOKEN";

// Name of the environment variable holding the shared secret protecting
// /read-config, /write-config, and /reload-config. Same two-state model as
// the restart token: unset, empty, or set-but-invalid disables the config
// API (all three routes answer 503) and the service boots with a startup
// warning; only a valid token enables it. The request-side header is
// `x-config-token`.
export const CONFIG_TOKEN_ENV = "IP_PINGER_CONFIG_TOKEN";

// Shared validity rule for BOTH service tokens (RESTART_SERVICE_TOKEN and
// IP_PINGER_CONFIG_TOKEN): at least 32 alphanumeric characters (A-Z, a-z,
// 0-9). `openssl rand -hex 32` output satisfies it; base64 output (which
// may carry `+`, `/`, or `=`) does not. The charset is ASCII-only, so a
// character count is a byte count — no multibyte edge cases. Validated
// exactly once at startup: the constructor/startup NEVER fails on token
// state — an invalid value disables the related ability and warns, and a
// request header can never grant enablement.
export const SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9]{32,}$/;

/**
 * Shared predicate for the service tokens. True only when the raw value is
 * a non-empty string matching SERVICE_TOKEN_PATTERN (at least 32
 * alphanumeric characters). Undefined, empty, whitespace, too short, or any
 * non-alphanumeric character all yield false — the related ability is then
 * disabled and the service warns at startup instead of failing to boot.
 */
export function isValidServiceToken(raw: string | undefined): boolean {
    return raw !== undefined && SERVICE_TOKEN_PATTERN.test(raw);
}

// A capability injected from the composition root that initiates the
// process's existing graceful shutdown. The route layer only schedules it,
// after an authenticated request has been accepted and acknowledged; it
// never signals or exits the process itself.
export type RequestRestart = () => void;

// The /restart-service capability as handed to the route layer. `token` is
// the validated secret (undefined means the endpoint is disabled) and
// `requestRestart` is the shutdown hook. Production supplies both; if
// either is missing the endpoint fails closed (503) and never calls
// process.exit.
export interface RestartServiceOptions {
    token?: string;
    requestRestart?: RequestRestart;
}

/**
 * Validates the configured restart secret at startup.
 *
 * Returns the secret unchanged when it is valid (SERVICE_TOKEN_PATTERN),
 * and undefined otherwise. Validation NEVER throws: unset, empty, or
 * set-but-invalid all leave the endpoint disabled and the service boots —
 * the composition root logs a startup warning for the invalid case. This
 * replaced the former fail-boot-on-weak-secret behavior.
 */
export function validateRestartServiceToken(raw: string | undefined): string | undefined {
    return isValidServiceToken(raw) ? raw : undefined;
}

// The subset of the app logger the startup-state logging needs. A structural
// type (not the full ILogger) so this module stays free of an import on the
// logger implementation; the real ILogger satisfies it.
type TokenStartupLogger = {
    write_info: (originator: string, message: string) => void;
    write_warn: (originator: string, message: string) => void;
};

// Originator for the startup token logs: they are emitted during the
// composition root's initialize step (index.ts), which merely delegates the
// formatting and event names here so the two-state logging is unit-testable.
const STARTUP_ORIGINATOR = "index.initialize";

/**
 * Resolves a service token's startup state: logs the state and returns the
 * validated secret, or undefined when the related ability is disabled.
 *
 * Two-state model (identical for the restart and config tokens):
 *   - unset or empty (compose delivers empty for an unset variable) -> a
 *     `<kind>_token_not_set` warn, ability disabled, returns undefined;
 *   - set but invalid (does not match SERVICE_TOKEN_PATTERN) -> a
 *     `<kind>_token_invalid` warn, ability disabled, returns undefined;
 *   - valid -> a `<kind>_..._enabled` info, ability enabled, returns the secret.
 *
 * The token value is NEVER logged — the invalid case names only the rule.
 * The constructor/startup never fails on token state: every path returns (it
 * never throws), so a misconfigured environment disables one ability instead
 * of taking the whole service down.
 */
export function resolveServiceTokenState(logger: TokenStartupLogger, kind: "restart" | "config", raw: string | undefined): string | undefined {
    if (isValidServiceToken(raw)) {
        if (kind === "config") {
            logger.write_info(STARTUP_ORIGINATOR, `config_api_enabled: /read-config, /write-config, and /reload-config enabled (x-config-token header required)`);
        } else {
            logger.write_info(STARTUP_ORIGINATOR, `restart_endpoint_enabled: POST /restart-service endpoint enabled (Authorization: Bearer required)`);
        }
        return raw;
    }
    if (raw === undefined || raw === "") {
        if (kind === "config") {
            logger.write_warn(STARTUP_ORIGINATOR, `config_token_not_set: ${CONFIG_TOKEN_ENV} is not set — /read-config, /write-config, and /reload-config are disabled (503)`);
        } else {
            logger.write_warn(STARTUP_ORIGINATOR, `restart_token_not_set: ${RESTART_SERVICE_TOKEN_ENV} is not set — POST /restart-service is disabled (503)`);
        }
        return undefined;
    }
    if (kind === "config") {
        logger.write_warn(STARTUP_ORIGINATOR, `config_token_invalid: ${CONFIG_TOKEN_ENV} is set but invalid (a valid token is at least 32 alphanumeric characters, A-Z, a-z, 0-9) — /read-config, /write-config, and /reload-config are disabled (503)`);
    } else {
        logger.write_warn(STARTUP_ORIGINATOR, `restart_token_invalid: ${RESTART_SERVICE_TOKEN_ENV} is set but invalid (a valid token is at least 32 alphanumeric characters, A-Z, a-z, 0-9) — POST /restart-service is disabled (503)`);
    }
    return undefined;
}

/**
 * Checks a request's Authorization header against the configured restart
 * secret.
 *
 * The format is validated exactly: one case-sensitive `Bearer` scheme, a
 * single space, and a single token with no embedded whitespace (so a
 * duplicate or comma-joined header is rejected before any comparison).
 * The comparison itself is constant-time (timingSafeEqual) and only runs
 * when the candidate and the secret have the same byte size; a size
 * difference is a definitive reject without touching the timing-safe path.
 */
export function isAuthorizedRestartBearer(authorization: string | undefined, token: string): boolean {
    if (authorization === undefined) {
        return false;
    }
    const scheme = "Bearer ";
    if (!authorization.startsWith(scheme)) {
        return false;
    }
    const candidate = authorization.slice(scheme.length);
    if (candidate === "" || /\s/.test(candidate)) {
        return false;
    }
    const candidateBytes = Buffer.from(candidate, "utf8");
    const tokenBytes = Buffer.from(token, "utf8");
    if (candidateBytes.length !== tokenBytes.length) {
        return false;
    }
    return timingSafeEqual(candidateBytes, tokenBytes);
}
