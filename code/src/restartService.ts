/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { timingSafeEqual } from "crypto";

// Name of the environment variable holding the /restart-service bearer
// secret. It is read and validated exactly once at startup by the
// composition root (index.ts): unset or empty leaves the endpoint
// disabled; a present-but-weak value fails the boot.
export const RESTART_SERVICE_TOKEN_ENV = "RESTART_SERVICE_TOKEN";

// Minimum secret size, in bytes. A shorter secret is an operator
// configuration error, and failing startup loudly is preferable to arming
// a restart button that is trivially guessable.
export const MIN_RESTART_TOKEN_BYTES = 32;

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
 * An absent secret (undefined or empty) disables the endpoint and returns
 * undefined. A secret that is present but not usable — whitespace-only, or
 * shorter than MIN_RESTART_TOKEN_BYTES — is an operator configuration
 * error and throws, so a weak or misconfigured secret fails the process at
 * boot instead of leaving an open (or guessable) restart endpoint running.
 */
export function validateRestartServiceToken(raw: string | undefined): string | undefined {
    if (raw === undefined || raw === "") {
        return undefined;
    }
    if (raw.trim() === "") {
        throw new Error(`${RESTART_SERVICE_TOKEN_ENV} must not be whitespace-only.`);
    }
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes < MIN_RESTART_TOKEN_BYTES) {
        throw new Error(
            `${RESTART_SERVICE_TOKEN_ENV} must be at least ${MIN_RESTART_TOKEN_BYTES} bytes of random secret (e.g. 'openssl rand -hex 32'); a shorter secret would arm a guessable restart endpoint.`
        );
    }
    return raw;
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
