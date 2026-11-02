#!/bin/sh
# StoryForge for macOS and Linux: ./storyforge.sh [options]. Anything after the name goes to the server (for example: ./storyforge.sh --library ~/Books).
# Needs Node.js 22 or newer. The first run installs what StoryForge needs (npm ci) and builds the app; later runs go straight to the browser.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "StoryForge needs Node.js 22 or newer, and it was not found." >&2
  echo "Install it from https://nodejs.org and run this again." >&2
  exit 1
fi
exec node scripts/launch.mjs "$@"
