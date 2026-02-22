#!/bin/sh
# Publish kind 10050 (DM relay discovery) using BOT_RELAYS from .env.
# Splits BOT_RELAYS by comma: one -t "relay=URL" tag per relay, and space-separated positional args.
# Requires: nak (https://github.com/fiatjaf/nak)

set -e

cd "$(dirname "$0")"

[ -f .env ] || {
  echo "Error: .env not found. Run from dm-bot directory." >&2
  exit 1
}
. ./.env

[ -n "$BOT_RELAYS" ] || {
  echo "Error: BOT_RELAYS not set in .env" >&2
  exit 1
}
[ -n "$BOT_KEY" ] || {
  echo "Error: BOT_KEY not set in .env" >&2
  exit 1
}

# Discovery relays where the 10050 event is published (so clients can find it)
DISCOVERY="wss://relay.0xchat.com wss://purplepag.es wss://relay.damus.io wss://relay.primal.net wss://user.kindpag.es wss://relay.nos.social"

# Parse BOT_RELAYS by comma into space-separated list
RELAY_LIST=""
OLD_IFS="$IFS"
IFS=','
for r in $BOT_RELAYS; do
  r=$(echo "$r" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$r" ] && continue
  if [ -z "$RELAY_LIST" ]; then
    RELAY_LIST="$r"
  else
    RELAY_LIST="$RELAY_LIST $r"
  fi
done
IFS="$OLD_IFS"

# Build nak event args: -k 10050, -t "relay=X" for each, -c '', --sec, then positional relays
set -- -k 10050

for r in $RELAY_LIST; do
  [ -z "$r" ] && continue
  set -- "$@" -t "relay=$r"
done

set -- "$@" -c '' --sec "$BOT_KEY"

for r in $RELAY_LIST; do
  [ -z "$r" ] && continue
  set -- "$@" "$r"
done

for r in $DISCOVERY; do
  set -- "$@" "$r"
done

exec nak event "$@"
