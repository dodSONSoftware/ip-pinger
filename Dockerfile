# ------------------------------------------------
# Stage 1: Build the TypeScript application

# Start with a Node.js image
FROM node:22 AS builder

# Set the working directory
WORKDIR /app

# Copy files
COPY . .

# Install only production dependencies (this will also include TypeScript if it's listed in devDependencies)
RUN npm install -g typescript
RUN npm ci --include=dev 
RUN npx tsc

# ------------------------------------------------
# Stage 2: Create the final image

# Start with a Node.js image
FROM node:22

# Set the working directory
WORKDIR /app

# Copy only the necessary files from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install only production dependencies
RUN npm install --only=production && npm cache clean --force

# Install Docker CLI (if required)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
    > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app/dist

# Expose the application port
EXPOSE 3300

# Command to run the application (replace with your actual entry point)
CMD ["node", "index.js"]
