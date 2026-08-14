#!/bin/sh
set -eu
docker exec sightops-prod-nginx sh -lc "grep -n 'cameras.js?v=167' /usr/share/nginx/html/v2/index.html"
docker exec sightops-prod-nginx sh -lc "grep -n 'imported layer' /usr/share/nginx/html/v2/js/cameras.js >/dev/null || grep -n 'importedSignatures' /usr/share/nginx/html/v2/js/cameras.js"
docker exec sightops-prod-api python /app/scripts/sightops_map_status_probe.py easy-tecnologias olt
