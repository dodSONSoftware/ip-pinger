#!/bin/bash

echo "Docker building docker image: ip-pinger"
docker build -t ip-pinger:latest --no-cache .

echo
echo "Docker running docker container: ip-pinger"

# Run with network capabilities
docker run -d \
  --name ip-pinger \
  --restart unless-stopped \
  -p 3300:3300 \
  -p 9090:9090 \
  --cap-add=NET_RAW \
  --cap-add=NET_ADMIN \
  -v /mnt/ip-pinger-data/config.json:/app/dist/config.json \
  ip-pinger:latest

echo
echo "----"
docker image ls -a
echo
docker container ls -a
