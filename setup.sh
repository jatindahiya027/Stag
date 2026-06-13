#!/usr/bin/env bash
set -euo pipefail

echo "Stag developer setup"
echo "===================="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 22 LTS or newer."
  exit 1
fi

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22 LTS or newer is required. Current version: $(node --version)"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required."
  exit 1
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "Installing the exact dependency tree from package-lock.json..."
npm ci

echo
echo "Setup complete."
echo "Development: npm run dev"
echo "Verification: npm test"
echo "Build renderer: npm run build"
