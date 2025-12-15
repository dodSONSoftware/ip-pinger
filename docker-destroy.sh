#!/bin/bash

echo "Docker stopping container: ip-pinger-2"
docker container stop ip-pinger-2

echo
echo "Docker removing container: ip-pinger-2"
docker container rm ip-pinger-2

echo
echo "Docker removing image: ip-pinger-2:1.0"
docker image rm ip-pinger-2:1.0

echo
echo "Docker pruning images"
docker image prune -af

echo
echo "----"
docker image ls -a
echo
docker container ls -a
