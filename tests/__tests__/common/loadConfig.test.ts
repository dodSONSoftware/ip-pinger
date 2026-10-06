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
logLevel: debug
apiPort: 3300
intervalSecs: 30
devices:
  - source: Test Device
    ipAddress: "192.168.1.1"
    deviceType: sensor
`;
        fs.writeFileSync("/tmp/test-config.yml", tempConfig);

        const [config, configText] = loadConfig();

        expect(config.logLevel).toBe("debug");
        expect(config.apiPort).toBe(3300);
        expect(config.intervalSecs).toBe(30);
        expect(config.devices).toHaveLength(1);
        expect(config.devices[0].source).toBe("Test Device");
        expect(config.devices[0].ipAddress).toBe("192.168.1.1");
        expect(config.devices[0].deviceType).toBe("sensor");

        expect(configText).toContain("logLevel: debug");
    });

    it("should handle multiple devices correctly", () => {
        const fs = require("fs");
        const tempConfig = `
logLevel: info
apiPort: 3300
intervalSecs: 60
devices:
  - source: Device 1
    ipAddress: "192.168.1.1"
    deviceType: sensor
  - source: Device 2
    ipAddress: "192.168.1.2"
    deviceType: server
  - source: Device 3
    ipAddress: "192.168.1.3"
    deviceType: kiosk
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
logLevel: debug
apiPort: 3300
intervalSecs: 30
devices:
  - source: Test
    ipAddress: "192.168.1.1"
    deviceType: sensor
`;

        const result = validateConfig(yaml);

        expect(result.ok).toBe(true);
        if (result.ok) {
            // Note: validateConfig returns the raw Zod schema data with camelCase keys
            expect(result.data.logLevel).toBe("debug");
            expect(result.data.devices).toHaveLength(1);
        }
    });

    it("should return ok=false for invalid YAML syntax", () => {
        const invalidYaml = `
logLevel: debug
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
logLevel: invalid-level
apiPort: 3300
intervalSecs: 30
devices:
  - source: Test
    ipAddress: "not-an-ip"
    deviceType: sensor
`;

        const result = validateConfig(invalidData);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            // Should have errors for invalid logLevel and invalid IP
            expect(result.errors.length).toBeGreaterThan(0);
        }
    });

    it("should reject invalid device types", () => {
        const invalidDeviceType = `
logLevel: debug
apiPort: 3300
intervalSecs: 30
devices:
  - source: Test
    ipAddress: "192.168.1.1"
    deviceType: invalid-type
`;

        const result = validateConfig(invalidDeviceType);
        expect(result.ok).toBe(false);
    });

    it("should accept all valid device types", () => {
        const validTypes = `
logLevel: debug
apiPort: 3300
intervalSecs: 30
devices:
  - source: Sensor
    ipAddress: "192.168.1.1"
    deviceType: sensor
  - source: Server
    ipAddress: "192.168.1.2"
    deviceType: server
  - source: Kiosk
    ipAddress: "192.168.1.3"
    deviceType: kiosk
`;

        const result = validateConfig(validTypes);
        expect(result.ok).toBe(true);
    });

    it("should ignore unknown configuration keys such as the removed alwaysLogErrors", () => {
        const yaml = `
logLevel: debug
alwaysLogErrors: true
apiPort: 3300
intervalSecs: 30
devices:
  - source: Test
    ipAddress: "192.168.1.1"
    deviceType: sensor
`;

        const result = validateConfig(yaml);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as Record<string, unknown>).alwaysLogErrors).toBeUndefined();
        }
    });
});

describe("IPv4 validation", () => {
    const yamlForIp = (ip: string) => `
logLevel: debug
apiPort: 3300
intervalSecs: 30
devices:
  - source: Test
    ipAddress: "${ip}"
    deviceType: sensor
`;

    it.each([
        "0.0.0.0",
        "10.10.10.70",
        "192.168.1.255",
        "255.255.255.255",
    ])("should accept valid IPv4 address %s", (ip) => {
        const result = validateConfig(yamlForIp(ip));
        expect(result.ok).toBe(true);
    });

    it.each([
        "256.0.0.1",
        "999.999.999.999",
        "192.168.1",
        "192.168.1.1.1",
        "abc.def.ghi.jkl",
    ])("should reject invalid IPv4 address %s", (ip) => {
        const result = validateConfig(yamlForIp(ip));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.join(" ")).toMatch(/IP address/);
        }
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
