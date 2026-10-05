/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import swaggerJsDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import type { Express } from "express";
import { APP_VERSION } from "./version";

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
    apis: ["./src/routes/**/*.ts"], // Recursively include all .ts files in all subdirectories
};

export const setupSwagger = (app: Express) => {
    app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerJsDoc(swaggerOptions)));
};
