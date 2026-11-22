#!/bin/bash

set -e
cd "$(cd -- "$(dirname -- "$0")/.." && pwd)"

source "$(pwd)/scripts/macos-dev-environment.sh"

# Never inherit an ancestor detached-child marker from an injector-launched Antigravity process.
unset AQ_DETACHED_CHILD AQ_LAUNCH_STATUS_FILE

echo "Starting Antigravity Quota Injector development version..."
exec npm run launch
