/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

declare module 'net-ping' {
    import * as events from 'events';

    // Values match the installed library (net-ping 1.2.4 assigns IPv4 = 1
    // and IPv6 = 2 — not the 0/1 values of node's net IP-family constants).
    // The runtime reads them from the real module; a value import of this
    // enum must therefore carry the library's actual numbers.
    export enum NetworkProtocol {
        IPv4 = 1,
        IPv6 = 2,
    }

    export interface SessionOptions {
        networkProtocol?: NetworkProtocol;
        packetSize?: number;
        retries?: number;
        sessionId?: number;
        timeout?: number;
        ttl?: number;
    }

    export interface PingResult {
        target: string;
        sent: Date;
        received: Date;
    }

    // The library's ICMP error classes, mirroring the exports of net-ping
    // 1.2.4. At runtime they are constructor functions wired with
    // util.inherits(X, Error) rather than ES classes, but instanceof works
    // through the prototype chain, so they are declared as Error subclasses.
    // Pinger.getErrorType classifies the first three via instanceof; the
    // rest are declared so a future instanceof check cannot reference a
    // class the library does not export.
    export class RequestTimedOutError extends Error { }
    export class DestinationUnreachableError extends Error {
        constructor(source: string);
        source: string;
    }
    export class TimeExceededError extends Error {
        constructor(source: string);
        source: string;
    }
    export class PacketTooBigError extends Error {
        constructor(source: string);
        source: string;
    }
    export class ParameterProblemError extends Error {
        constructor(source: string);
        source: string;
    }
    export class RedirectReceivedError extends Error {
        constructor(source: string);
        source: string;
    }
    export class SourceQuenchError extends Error {
        constructor(source: string);
        source: string;
    }

    export class Session extends events.EventEmitter {
        constructor(options: SessionOptions);

        pingHost(target: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void): void;
        close(): void;

        on(event: 'close', listener: () => void): this;
        on(event: 'error', listener: (error: Error) => void): this;
    }

    export function createSession(options: SessionOptions): Session;
}
