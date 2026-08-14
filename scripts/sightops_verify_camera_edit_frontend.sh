#!/bin/sh
set -eu
docker exec sightops-prod-nginx sh -lc "grep -n 'connectors.js?v=161' /usr/share/nginx/html/v2/index.html"
docker exec sightops-prod-nginx sh -lc "grep -n 'Filtro alterado' /usr/share/nginx/html/v2/js/connectors.js"
docker exec sightops-prod-api python /app/scripts/sightops_camera_save_probe.py easy-tecnologias olt "JARDINS II"
