#!/bin/bash

echo "Docker building docker image: ip-pinger"
docker build -t ip-pinger:1.0 --no-cache .

echo
echo "Docker running docker container: ip-pinger"

# running a docker container in privileged mode is not ideal; further research is needed.
docker run -d \
           --privileged \
           --name ip-pinger \
           -p 3300:3300 \
           -v /var/run/docker.sock:/var/run/docker.sock \
           -v /mnt/ip-pinger-data/config.json:/app/dist/config.json \
           ip-pinger:1.0

echo
echo "----"
docker image ls -a
echo
docker container ls -a
