/*
 * Copyright (c) 2025 dodson Software ( dodson labs )
 * Author: Randy Dodson <dodsonsoftware@gmail.com>
 * Licensed under the MIT License with Patent Grant and NOTICE preservation.
 * See the LICENSE file for the full terms.
 */

import swaggerJsDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { Express } from "express";

const swaggerOptions = {
    swaggerDefinition: {
        openapi: "3.0.0",
        info: {
            title: "IP Pinger",
            version: "0.1.0",
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
