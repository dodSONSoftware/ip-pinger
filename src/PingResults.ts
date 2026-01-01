/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import { IPingResults } from "./interfaces";



export class PingResults implements IPingResults {
    source: string;
    ip_address: string;
    is_alive: boolean;
    roundtrip_ms: number;

    constructor(source: string, ip_address: string, is_alive: boolean, roundtrip_ms: number) {
        this.source = source;
        this.ip_address = ip_address;
        this.is_alive = is_alive;
        this.roundtrip_ms = roundtrip_ms;
    }

    public toString(): string {
        return `source: ${this.source}, ip_address: ${this.ip_address}, is_alive: ${this.is_alive}, roundtrip_ms: ${this.roundtrip_ms}`;
    }
}
