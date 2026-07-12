#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Stopping and removing existing container..."
docker container stop ip-pinger 2>/dev/null || true
docker container rm ip-pinger 2>/dev/null || true

echo
echo "Removing existing image..."
docker image rm ip-pinger:latest 2>/dev/null || true

echo
echo "Building new docker image: ip-pinger"
docker build -t ip-pinger:latest --no-cache .

echo
echo "Starting new container: ip-pinger"

# Run with network capabilities
# Note: CONFIG_PATH must be set to point to the mounted config file
docker run -d \
  --name ip-pinger \
  --restart unless-stopped \
  -p 3300:3300 \
  -p 9090:9090 \
  --cap-add=NET_RAW \
  --cap-add=NET_ADMIN \
  -e CONFIG_PATH=/mnt/ip-pinger-data/config.json \
  -v /mnt/ip-pinger-data/config.json:/mnt/ip-pinger-data/config.json:ro \
  ip-pinger:latest

echo
echo "Waiting for container to start..."
sleep 5

echo
echo "----"
docker image ls -a
echo
docker container ls -a

echo
echo "Container logs:"
docker logs -f ip-pinger
