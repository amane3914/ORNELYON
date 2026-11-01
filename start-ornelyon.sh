#!/bin/sh
# ORNELYON launcher for macOS and Linux. No administrator rights are needed.
# Requires Node.js 20 or newer. Nothing is installed globally.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js 20 LTS from https://nodejs.org and run this again."
  exit 1
fi

exec node dist/interface/cli.js gui "$@"
