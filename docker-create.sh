#!/bin/bash

echo "Docker building docker image: ip-pinger-2"
docker build -t ip-pinger-2:1.0 --no-cache .

echo
echo "Docker running docker container: ip-pinger-2"

# running a docker container in privileged mode is not ideal; further research is needed.
docker run -d \
           --privileged \
           --name ip-pinger-2 \
           -p 3300:3300 \
           -v /mnt/ip-pinger-data/config.json:/app/dist/config.json \
           ip-pinger-2:1.0

echo
echo "----"
docker image ls -a
echo
docker container ls -a
