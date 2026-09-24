#!/bin/sh
# PI_BIN launcher for the stub pi. The server spawns "$PI_BIN" --mode rpc;
# the stub ignores those arguments.
exec node "$(dirname "$0")/stub-pi.mjs" "$@"