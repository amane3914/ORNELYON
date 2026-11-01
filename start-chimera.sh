#!/bin/sh
# Compatibility launcher from CHIMERA Harness v0.1. Starts ORNELYON; use start-ornelyon.sh instead.
exec "$(dirname "$0")/start-ornelyon.sh" "$@"
