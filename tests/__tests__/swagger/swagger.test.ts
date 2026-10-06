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
});
