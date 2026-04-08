#!/bin/bash
set -e

# Execute plugin entrypoint commands (base64-encoded JSON array of shell commands)
if [ -n "$NANOCLAW_PLUGIN_COMMANDS" ]; then
  echo "$NANOCLAW_PLUGIN_COMMANDS" | base64 -d | node -e "
    const cmds = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    for (const cmd of cmds) { console.log(cmd); }
  " | while IFS= read -r cmd; do
    eval "$cmd" || true
  done
fi

# Build agent-runner from source
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read input and run
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
