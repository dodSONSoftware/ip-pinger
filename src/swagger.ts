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
        servers: [
            {
                url: "http://192.168.7.131:3300/", // Change this to your server URL
            },
        ],
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
