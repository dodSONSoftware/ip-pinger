# ------------------------------------------------
# Stage 1: Build the TypeScript application

# Start with a NodeJS image
FROM node:22 AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Compile the TypeScript code
RUN npx tsc

# ------------------------------------------------
# Stage 2: Create the final image

# Start with a NodeJS image
FROM node:22

# Set the working directory
WORKDIR /app

# Copy only the necessary files from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install only production dependencies
RUN npm install --only=production && npm cache clean --force

# Set the working directory
WORKDIR /app/dist

# Exposed ports
EXPOSE 3300

# Command to run the application
CMD ["node", "index.js"]
