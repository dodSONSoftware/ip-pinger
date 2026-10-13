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

        expect(result.success).toBe(true);
        expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    });

    it("should overwrite existing file content", () => {
        const filePath = path.join(testDir, "test-overwrite.txt");
        const originalContent = "Original content";
        const newContent = "New content";

        fs.writeFileSync(filePath, originalContent);

        const result = write_file(filePath, newContent);

        expect(result.success).toBe(true);
        expect(fs.readFileSync(filePath, "utf8")).toBe(newContent);
    });

    it("should return false when writing to an invalid path", () => {
        const filePath = "/nonexistent-directory/test.txt";
        const result = write_file(filePath, "test");

        expect(result.success).toBe(false);
    });
});

describe("write_file (atomic replacement)", () => {
    const testDir = "/tmp/ip-pinger-tests";

    // The raw fs module object. systemFunctions imports the default export
    // of "fs", which in CommonJS is this same object, so spying on it
    // intercepts write_file's own fs calls.
    const realFs = jest.requireActual("fs") as typeof import("fs");

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

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("replaces the target file with the new content and leaves no temporary file behind", () => {
        const filePath = path.join(testDir, "atomic-target.yml");
        fs.writeFileSync(filePath, "OLD");

        const result = write_file(filePath, "NEW");

        expect(result.success).toBe(true);
        expect(fs.readFileSync(filePath, "utf8")).toBe("NEW");
        expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    });

    it("keeps the existing content intact and reports the original failure when the temporary write fails", () => {
        const filePath = path.join(testDir, "atomic-tmp-fail.yml");
        fs.writeFileSync(filePath, "OLD");

        // Fail only the temporary write; the live target must never be opened
        const originalWriteFileSync = realFs.writeFileSync;
        jest.spyOn(realFs, "writeFileSync").mockImplementation(((
            file: fs.PathOrFileDescriptor,
            data: string
        ): void => {
            if (String(file).endsWith(".tmp")) {
                throw new Error("simulated temporary write failure");
            }
            originalWriteFileSync(file, data);
        }) as typeof realFs.writeFileSync);

        const result = write_file(filePath, "NEW");

        expect(result.success).toBe(false);
        // The original failure is reported, not masked by cleanup
        expect(result.error).toContain("simulated temporary write failure");
        // The live configuration is untouched and no temporary file remains
        expect(fs.readFileSync(filePath, "utf8")).toBe("OLD");
        expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    });

    it("reports failure, keeps the existing content, and removes the temporary file when the rename fails", () => {
        const filePath = path.join(testDir, "atomic-rename-fail.yml");
        fs.writeFileSync(filePath, "OLD");

        jest.spyOn(realFs, "renameSync").mockImplementation(() => {
            throw new Error("simulated rename failure");
        });

        const result = write_file(filePath, "NEW");

        expect(result.success).toBe(false);
        expect(result.error).toContain("simulated rename failure");
        expect(fs.readFileSync(filePath, "utf8")).toBe("OLD");
        // The temporary file is cleaned up after the failed rename
        expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
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
