#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/maintenance/cleanup.sh" "$@"
