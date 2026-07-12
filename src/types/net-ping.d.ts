/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

declare module 'net-ping' {
    import * as events from 'events';

    export enum NetworkProtocol {
        IPv4 = 0,
        IPv6 = 1,
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

    export class Session extends events.EventEmitter {
        constructor(options: SessionOptions);

        pingHost(target: string, callback: (error: Error | null, target: string, sent: Date, received: Date) => void): void;
        close(): void;

        on(event: 'close', listener: () => void): this;
        on(event: 'error', listener: (error: Error) => void): this;
    }

    function createSession(options: SessionOptions): Session;
    const NetworkProtocol: typeof NetworkProtocol;

    export default {
        createSession,
        NetworkProtocol,
    };
}
