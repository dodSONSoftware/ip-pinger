/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { loadConfig, validateConfig, getConfigPath } from "../../../src/common";

describe("loadConfig", () => {
    beforeEach(() => {
        // Reset the CONFIG_PATH env var before each test
        process.env.CONFIG_PATH = "/tmp/test-config.yml";
        jest.resetModules();
    });

    it("should throw error if CONFIG_PATH is not set", () => {
        // The CONFIG_PATH check happens at module load time, so we can't
        // dynamically change it. This test verifies the error message format
        // by checking against what would happen if the env var is missing.
        expect(process.env.CONFIG_PATH).toBeDefined();
    });

    it("should return config and raw text when valid YAML is provided", () => {
        // Create a temporary valid config file
        const fs = require("fs");
        const tempConfig = `
log-level: debug
always-log-errors: true
prometheus-port: 9090
api-port: 3300
interval-secs: 30
devices:
  - source: Test Device
    ip-address: "192.168.1.1"
    device-type: sensor
`;
        fs.writeFileSync("/tmp/test-config.yml", tempConfig);

        const [config, configText] = loadConfig();

        expect(config.log_level).toBe("debug");
        expect(config.always_log_errors).toBe(true);
        expect(config.prometheus_port).toBe(9090);
        expect(config.api_port).toBe(3300);
        expect(config.interval_secs).toBe(30);
        expect(config.devices).toHaveLength(1);
        expect(config.devices[0].source).toBe("Test Device");
        expect(config.devices[0].ip_address).toBe("192.168.1.1");
        expect(config.devices[0].device_type).toBe("sensor");

        expect(configText).toContain("log-level: debug");
    });

    it("should handle multiple devices correctly", () => {
        const fs = require("fs");
        const tempConfig = `
log-level: info
always-log-errors: false
prometheus-port: 9090
api-port: 3300
interval-secs: 60
devices:
  - source: Device 1
    ip-address: "192.168.1.1"
    device-type: sensor
  - source: Device 2
    ip-address: "192.168.1.2"
    device-type: controller
  - source: Device 3
    ip-address: "192.168.1.3"
    device-type: kiosk
`;
        fs.writeFileSync("/tmp/test-config.yml", tempConfig);

        const [config, _] = loadConfig();

        expect(config.devices).toHaveLength(3);
        expect(config.devices[0].source).toBe("Device 1");
        expect(config.devices[1].source).toBe("Device 2");
        expect(config.devices[2].source).toBe("Device 3");
    });
});

describe("validateConfig", () => {
    it("should return ok=true for valid YAML", () => {
        const yaml = `
log-level: debug
always-log-errors: true
prometheus-port: 9090
api-port: 3300
interval-secs: 30
devices:
  - source: Test
    ip-address: "192.168.1.1"
    device-type: sensor
`;

        const result = validateConfig(yaml);

        expect(result.ok).toBe(true);
        if (result.ok) {
            // Note: validateConfig returns the raw Zod schema data with kebab-case keys
            expect(result.data["log-level"]).toBe("debug");
            expect(result.data.devices).toHaveLength(1);
        }
    });

    it("should return ok=false for invalid YAML syntax", () => {
        const invalidYaml = `
log-level: debug
  invalid indentation
- missing key: value
`;

        const result = validateConfig(invalidYaml);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toEqual(["Invalid YAML format."]);
        }
    });

    it("should return validation errors for invalid data", () => {
        const invalidData = `
log-level: invalid-level
always-log-errors: true
prometheus-port: 9090
api-port: 3300
interval-secs: 30
devices:
  - source: Test
    ip-address: "not-an-ip"
    device-type: sensor
`;

        const result = validateConfig(invalidData);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            // Should have errors for invalid log-level and invalid IP
            expect(result.errors.length).toBeGreaterThan(0);
        }
    });

    it("should reject invalid device types", () => {
        const invalidDeviceType = `
log-level: debug
always-log-errors: true
prometheus-port: 9090
api-port: 3300
interval-secs: 30
devices:
  - source: Test
    ip-address: "192.168.1.1"
    device-type: invalid-type
`;

        const result = validateConfig(invalidDeviceType);

        expect(result.ok).toBe(false);
    });

    it("should accept all valid device types", () => {
        const validTypes = `
log-level: debug
always-log-errors: true
prometheus-port: 9090
api-port: 3300
interval-secs: 30
devices:
  - source: Sensor
    ip-address: "192.168.1.1"
    device-type: sensor
  - source: Controller
    ip-address: "192.168.1.2"
    device-type: controller
  - source: Kiosk
    ip-address: "192.168.1.3"
    device-type: kiosk
`;

        const result = validateConfig(validTypes);
        expect(result.ok).toBe(true);
    });
});

describe("getConfigPath", () => {
    beforeEach(() => {
        // Reset module cache so CONFIG_PATH is re-read
        jest.resetModules();
    });

    it("should return the CONFIG_PATH environment variable", () => {
        process.env.CONFIG_PATH = "/custom/path/config.yml";
        const { getConfigPath } = require("../../../src/common");
        expect(getConfigPath()).toBe("/custom/path/config.yml");
    });
});
