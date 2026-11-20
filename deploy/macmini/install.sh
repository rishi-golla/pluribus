#!/bin/zsh
# Runs the Pluribus chain and services on the Mac mini as launchd agents, and serves them over Tailscale Funnel
# Run it on the mini from the repo root: deploy/macmini/install.sh. Rerunning it is safe and reloads every agent
set -euo pipefail

REPO=${0:A:h:h:h}
LOGS=$REPO/deploy/macmini/logs
AGENTS=$HOME/Library/LaunchAgents
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
# Off the stock 8899: the validator takes the 2000 ports above its RPC port minus 899, and other services use 8000-10000
RPC_PORT=18899
WS_PORT=$((RPC_PORT + 1))
INDEXER_PORT=18787
# Funnel only serves on 443, 8443 and 10000, and the first two are taken on this machine
FUNNEL_PORT=10000
PATH_ENV="$HOME/.local/share/solana/install/active_release/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

export PATH=$PATH_ENV

mkdir -p "$LOGS" "$AGENTS"
# The program is built elsewhere, since the mini has no Rust toolchain
[[ -f $REPO/target/deploy/pluribus.so ]] || { echo "Copy target/deploy/pluribus.so here first"; exit 1; }
[[ -f $HOME/.config/solana/id.json ]] || solana-keygen new --no-bip39-passphrase --silent -o "$HOME/.config/solana/id.json"
# Signs the replay's webhooks, so nobody else can push events into the public indexer
TOKEN_FILE=$REPO/deploy/macmini/.streams-token
[[ -f $TOKEN_FILE ]] || openssl rand -hex 32 > "$TOKEN_FILE"
TOKEN=$(<"$TOKEN_FILE")

# agent <name> <extra env as KEY=VALUE...> -- <npm args...>
agent() {
  local name=$1; shift
  local env="" args=""
  while [[ $1 != -- ]]; do env+="<key>${1%%=*}</key><string>${1#*=}</string>"; shift; done
  shift
  for a in /opt/homebrew/bin/npm "$@"; do args+="<string>$a</string>"; done
  local label=com.pluribus.$name plist=$AGENTS/com.pluribus.$name.plist
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key><array>$args</array>
    <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH_ENV</string>$env</dict>
    <key>WorkingDirectory</key><string>$REPO</string>
    <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$LOGS/$name.log</string>
    <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Loaded $label, logs in $LOGS/$name.log"
}

# The keeper and the replay exit while the chain is still starting, and launchd starts them again ten seconds later
agent localnet -- run localnet -- --url "http://127.0.0.1:$RPC_PORT" --keep
agent keeper -- run keeper
agent indexer "PORT=$INDEXER_PORT" "STREAMS_TOKEN=$TOKEN" -- run indexer
agent replay "PORT=$INDEXER_PORT" "STREAMS_TOKEN=$TOKEN" -- run indexer:replay -- --follow

# Each service on its own path of one public port; Funnel strips the path before passing a request on
$TS funnel --bg --https=$FUNNEL_PORT --set-path=/rpc "http://127.0.0.1:$RPC_PORT"
$TS funnel --bg --https=$FUNNEL_PORT --set-path=/rpc-ws "http://127.0.0.1:$WS_PORT"
$TS funnel --bg --https=$FUNNEL_PORT --set-path=/indexer "http://127.0.0.1:$INDEXER_PORT"
$TS serve status
