#!/bin/bash
# Eagle Clone - Quick Setup Script

echo "🦅 Eagle Clone Setup"
echo "===================="
echo ""

if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Please install Node.js 18+ from https://nodejs.org"
  exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js 18+ required. Current: $(node -v)"; exit 1
fi

echo "✅ Node.js $(node -v)"
echo ""
echo "📦 Installing dependencies (no native compilation required)..."
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "Run in development:  npm run dev"
echo "Build for Windows:   npm run dist:win"
echo "Build for macOS:     npm run dist:mac"
echo ""
echo "NOTE: If you have an existing library.json it will be automatically"
echo "      migrated to SQLite on first launch (backup kept as library.json.bak)"
