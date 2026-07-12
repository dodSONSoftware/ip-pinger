/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { write_file, read_file, read_file_json } from "../../../src/systemFunctions";
import * as fs from "fs";
import * as path from "path";

describe("write_file", () => {
    const testDir = "/tmp/ip-pinger-tests";

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
    });

    afterAll(() => {
        // Clean up test files
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    it("should write content to a file and return true", () => {
        const filePath = path.join(testDir, "test-write.txt");
        const content = "Hello, World!";

        const result = write_file(filePath, content);

        expect(result).toBe(true);
        expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    });

    it("should overwrite existing file content", () => {
        const filePath = path.join(testDir, "test-overwrite.txt");
        const originalContent = "Original content";
        const newContent = "New content";

        fs.writeFileSync(filePath, originalContent);

        const result = write_file(filePath, newContent);

        expect(result).toBe(true);
        expect(fs.readFileSync(filePath, "utf8")).toBe(newContent);
    });

    it("should return false when writing to an invalid path", () => {
        const filePath = "/nonexistent-directory/test.txt";
        const result = write_file(filePath, "test");

        expect(result).toBe(false);
    });
});

describe("read_file", () => {
    const testDir = "/tmp/ip-pinger-tests";

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
    });

    afterAll(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    it("should read file content and return it as a string", () => {
        const filePath = path.join(testDir, "test-read.txt");
        const content = "Test content to read";
        fs.writeFileSync(filePath, content);

        const result = read_file(filePath);

        expect(result).toBe(content);
    });

    it("should return null when file does not exist", () => {
        const filePath = path.join(testDir, "nonexistent-file.txt");

        const result = read_file(filePath);

        expect(result).toBeNull();
    });
});

describe("read_file_json", () => {
    const testDir = "/tmp/ip-pinger-tests";

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
    });

    afterAll(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    it("should parse valid JSON and return a Map", () => {
        const filePath = path.join(testDir, "test-json.json");
        const content = '{"name": "test", "version": "1.0.0"}';
        fs.writeFileSync(filePath, content);

        const result = read_file_json(filePath);

        expect(result).toBeInstanceOf(Map);
        expect(result?.get("name")).toBe("test");
        expect(result?.get("version")).toBe("1.0.0");
    });

    it("should return null when file does not exist", () => {
        const filePath = path.join(testDir, "nonexistent.json");

        const result = read_file_json(filePath);

        expect(result).toBeNull();
    });

    it("should return null when file contains invalid JSON", () => {
        const filePath = path.join(testDir, "invalid-json.json");
        const content = '{invalid json}';
        fs.writeFileSync(filePath, content);

        const result = read_file_json(filePath);

        expect(result).toBeNull();
    });
});
