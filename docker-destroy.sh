#!/bin/bash

echo "Docker stopping container: ip-pinger"
docker container stop ip-pinger

echo
echo "Docker removing container: ip-pinger"
docker container rm ip-pinger

echo
echo "Docker removing image: ip-pinger:1.0"
docker image rm ip-pinger:1.0

echo
echo "Docker pruning images"
docker image prune -af

echo
echo "----"
docker image ls -a
echo
docker container ls -a
