#!/bin/bash

# Finder launchers may not inherit the interactive terminal's PATH.
export PATH="$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required."
  exit 1
fi
if ! node -e 'const [ma,mi]=process.versions.node.split(".").map(Number); process.exit((ma>22||(ma===22&&mi>=13))?0:1)' 2>/dev/null; then
  echo "Node.js >= 22.13.0 is required. Current version: $(node --version 2>/dev/null)"
  exit 1
fi
