/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

// Mock the net-ping library since we don't want to actually ping devices during tests.
// The mock mirrors the real net-ping v1.x API:
//   session.pingHost(host, callback(error, target, sent, received))
// The typed error classes mirror the real library's exported classes (names
// and messages), because error classification relies on them via instanceof.
// They are defined inside the factory: jest hoists jest.mock() and forbids
// the factory from referencing out-of-scope variables.
jest.mock("net-ping", () => {
    class RequestTimedOutError extends Error {
        constructor() {
            super("Request timed out");
            this.name = "RequestTimedOutError";
        }
    }
    class DestinationUnreachableError extends Error {
        constructor(source) {
            super("Destination unreachable (source=" + source + ")");
            this.name = "DestinationUnreachableError";
            this.source = source;
        }
    }
    class TimeExceededError extends Error {
        constructor(source) {
            super("Time exceeded (source=" + source + ")");
            this.name = "TimeExceededError";
            this.source = source;
        }
    }
    return {
    NetworkProtocol: {
        IPv4: "ip",
        IPv6: "ip6",
    },
    RequestTimedOutError,
    DestinationUnreachableError,
    TimeExceededError,
    createSession: jest.fn(() => ({
        lookup: jest.fn((address, callback) => {
            // Return a mock result that simulates successful resolution
            callback(null, {
                address: address,
                family: "IPv4",
                name: "",
            });
        }),
        pingHost: jest.fn((host, callback) => {
            // Default to a successful ping with 10ms roundtrip
            const sent = new Date();
            const received = new Date(sent.getTime() + 10);
            callback(null, host, sent, received);
        }),
        on: jest.fn(),
        close: jest.fn(),
    })),
    };
});

// Set CONFIG_PATH environment variable for tests. Each Jest worker is its
// own process (unique PID), so the per-worker path gives every test file a
// config file no other worker can clobber: suites that seed this file and
// then read it back through the API can never observe another suite's data.
process.env.CONFIG_PATH = `/tmp/test-config-${process.pid}.yml`;
