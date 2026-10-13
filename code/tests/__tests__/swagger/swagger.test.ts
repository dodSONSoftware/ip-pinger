/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import fs from "fs";
import path from "path";
import { getSwaggerSpec } from "../../../src/swagger";

const expectedPaths = [
    "/about",
    "/ping",
    "/ping/{target}",
    "/read-config",
    "/write-config",
    "/reload-config",
    "/metrics",
    "/health",
    "/endpoints",
];

function specPaths(spec: { paths?: Record<string, unknown> }): string[] {
    return Object.keys(spec.paths ?? {});
}

function specServers(spec: { servers?: Array<{ url?: string }> }): string[] {
    return (spec.servers ?? []).map((server) => server.url ?? "");
}

interface JsonSchema {
    type?: string;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
}

function responseSchema(spec: { paths?: Record<string, unknown> }, routePath: string, code: string): JsonSchema {
    const route = spec.paths?.[routePath] as
        | { get?: { responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> } }
        | undefined;
    return route?.get?.responses?.[code]?.content?.["application/json"]?.schema ?? {};
}

describe("Swagger route discovery", () => {
    it("discovers every documented route from the module-relative route path", () => {
        // The spec builder resolves routes relative to the swagger module itself,
        // so from the source layout it scans src/routes/*.ts
        const paths = specPaths(getSwaggerSpec());
        for (const expected of expectedPaths) {
            expect(paths).toContain(expected);
        }
    });

    it("discovers every documented route from the production compiled layout (dist/routes/*.js)", () => {
        const distRoutesFile = path.resolve(__dirname, "../../../dist/routes/generalRoutes.js");
        if (!fs.existsSync(distRoutesFile)) {
            console.warn("Skipping compiled-layout Swagger discovery test: dist/ has not been built.");
            return;
        }

        // Load the actually-compiled swagger module: its __dirname is dist/,
        // exactly the path the production runtime uses.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const distSwagger = require(path.resolve(__dirname, "../../../dist/swagger.js"));
        if (typeof distSwagger.getSwaggerSpec !== "function") {
            console.warn("Skipping compiled-layout Swagger discovery test: dist/swagger.js is stale. Run npm run build.");
            return;
        }

        const paths = specPaths(distSwagger.getSwaggerSpec());
        for (const expected of expectedPaths) {
            expect(paths).toContain(expected);
        }
    });

    it("does not advertise a deployment-specific server address", () => {
        // A `servers` entry with an absolute deployment URL would make
        // "Try it out" target whatever host was current when the spec was
        // written, so any advertised URL must be absent or relative.
        for (const url of specServers(getSwaggerSpec())) {
            expect(url).not.toMatch(/^(https?:)?\/\//);
            expect(url).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
        }
    });
});

describe("Swagger response schemas", () => {
    it("documents /ping as an array of per-device results matching the actual response shape", () => {
        // The handler answers with the per-device ping results array, not an
        // about/version envelope: the schema must say so, or Swagger UI's
        // "Try it out" example shows a shape the endpoint never returns.
        const schema = responseSchema(getSwaggerSpec(), "/ping", "200");

        expect(schema.type).toBe("array");
        expect(schema.items?.type).toBe("object");

        const expectedProperties: Record<string, string> = {
            ipAddress: "string",
            isAlive: "boolean",
            roundTripMs: "number",
            source: "string",
            deviceType: "string",
            error: "string",
        };
        for (const [name, type] of Object.entries(expectedProperties)) {
            expect(schema.items?.properties?.[name]?.type).toBe(type);
        }
    });

    it("documents /ping/{target} with the actual roundTripMs field name", () => {
        // The response field is roundTripMs (see the PingResult interface);
        // a lowercased-t variant would mislead anyone generating clients.
        const schema = responseSchema(getSwaggerSpec(), "/ping/{target}", "200");

        expect(schema.properties?.["roundTripMs"]?.type).toBe("number");
        expect(schema.properties?.["roundtripMs"]).toBeUndefined();
    });

    it("documents /read-config as the configuration object, not an about/version envelope", () => {
        const schema = responseSchema(getSwaggerSpec(), "/read-config", "200");

        expect(schema.type).toBe("object");
        expect(schema.properties?.["logLevel"]?.type).toBe("string");
        expect(schema.properties?.["intervalSecs"]?.type).toBe("integer");
        expect(schema.properties?.["devices"]?.type).toBe("array");

        const deviceItems = schema.properties?.["devices"]?.items;
        expect(deviceItems?.type).toBe("object");
        expect(deviceItems?.properties?.["source"]?.type).toBe("string");
        expect(deviceItems?.properties?.["ipAddress"]?.type).toBe("string");
        expect(deviceItems?.properties?.["deviceType"]?.type).toBe("string");

        // The old envelope properties must no longer be advertised
        expect(schema.properties?.["about"]).toBeUndefined();
        expect(schema.properties?.["version"]).toBeUndefined();
    });
});
