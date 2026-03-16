#!/bin/bash
cd "$(dirname "$0")"

# Kill existing bot processes
pkill -f "agents/node_modules/.bin/tsx src/index.ts" 2>/dev/null
pkill -f "agents/.*src/index.ts" 2>/dev/null
sleep 1

# Verify stopped
if pgrep -f "agents/.*src/index.ts" > /dev/null 2>&1; then
  echo "Force killing remaining processes..."
  pkill -9 -f "agents/.*src/index.ts" 2>/dev/null
  sleep 1
fi

# Start bot
nohup npx tsx src/index.ts > /tmp/agents-bot.log 2>&1 &
echo "Bot started (PID $!). Waiting for startup..."

sleep 3
if pgrep -f "agents/.*src/index.ts" > /dev/null 2>&1; then
  tail -5 /tmp/agents-bot.log
else
  echo "ERROR: Bot failed to start. Check /tmp/agents-bot.log"
  exit 1
fi
