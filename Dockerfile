# SPDX-License-Identifier: MIT
# Copyright (c) 2026 dodson Software ( dodson labs )

# Stage 1: Build the TypeScript application
FROM node:22-slim AS builder

# Install build tools for native modules
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./

# Install all dependencies (including devDependencies for native module compilation)
RUN npm ci

# Copy source code
COPY . .

# Compile TypeScript
RUN npx tsc

# ------------------------------------------------
# Stage 2: Production runtime
FROM node:22-slim

# Install runtime requirements (libcap2-bin for setcap, curl for healthcheck)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libcap2-bin \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy pre-compiled node_modules from builder (includes native modules)
COPY --from=builder /app/node_modules ./node_modules

# Copy pre-compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Expose the application ports
EXPOSE 3300
EXPOSE 9090

# Grant raw socket capabilities to Node.js binary (Linux capability approach)
# This allows raw sockets without running as root
RUN setcap cap_net_raw+ep $(readlink -f $(which node))

# Run as non-root user for better security
USER node

# Health check - probe the metrics endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -sf http://localhost:9090/metrics || exit 1

# Command to run the application
CMD ["node", "dist/index.js"]
