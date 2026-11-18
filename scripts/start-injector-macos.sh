#!/bin/bash

set -e
cd "$(cd -- "$(dirname -- "$0")/.." && pwd)"

source "$(pwd)/scripts/macos-dev-environment.sh"

echo "Starting Antigravity Quota Injector development version..."
exec npm run launch
