/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

// Mock the net-ping library since we don't want to actually ping devices during tests
jest.mock("net-ping", () => ({
    createSession: jest.fn(() => ({
        lookup: jest.fn((address, callback) => {
            // Return a mock result that simulates successful resolution
            callback(null, {
                address: address,
                family: "IPv4",
                name: "",
            });
        }),
        pingHost: jest.fn((options, callback) => {
            // Default to successful ping with 10ms roundtrip
            const roundTrip = options.roundTrip ?? 10;
            callback(null, {
                address: options.address,
                alive: true,
                roundTrip: roundTrip,
            });
        }),
        close: jest.fn(),
    })),
}));

// Set CONFIG_PATH environment variable for tests
process.env.CONFIG_PATH = "/tmp/test-config.yml";
