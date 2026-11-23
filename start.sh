#!/bin/sh
# Starts the server the image runs, chosen by BUDGET_SERVER: `bun` (the
# default) or `rust`. Both serve the same API and client from the same
# database, so switching back and forth is a restart with the other value.
set -e

case "${BUDGET_SERVER:-bun}" in
  bun)
    exec bun --no-install ./build/server/bundle.js
    ;;
  rust)
    # It finds the client in build/client, beside its own directory.
    exec ./build/server-rust/budget-server
    ;;
  *)
    echo "BUDGET_SERVER must be bun or rust, not \"$BUDGET_SERVER\"" >&2
    exit 1
    ;;
esac
