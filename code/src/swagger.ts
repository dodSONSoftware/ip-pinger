/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import swaggerJsDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import type { Express } from "express";
import { APP_VERSION } from "./version";
import path from "path";

const swaggerOptions = {
    swaggerDefinition: {
        openapi: "3.0.0",
        info: {
            title: "IP Pinger",
            version: APP_VERSION,
            description: "Will ping devices and report their roundtrip in milliseconds.",
        },
        // No `servers` entry: the OpenAPI spec deliberately carries no host
        // address, so Swagger UI uses the origin of the page serving the
        // document instead of a deployment-specific IP baked into source.
    },
    // Resolve the route annotations relative to this module so the same code works
    // in the compiled production layout (dist/routes/*.js) and in the source
    // development layout (src/routes/*.ts), regardless of the shell working directory.
    apis: [path.join(__dirname, "routes", "**", "*.{js,ts}")],
};

/**
 * Builds the OpenAPI document from the route JSDoc annotations using the
 * same module-relative route path the running application uses.
 */
export const getSwaggerSpec = () => swaggerJsDoc(swaggerOptions);

export const setupSwagger = (app: Express) => {
    app.use("/swagger", swaggerUi.serve, swaggerUi.setup(getSwaggerSpec()));
};
