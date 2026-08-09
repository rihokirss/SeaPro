#!/usr/bin/env bash
set -euo pipefail

# Tagasiühilduv käsunimi. Ametlik sügavuspakett sisaldab nüüd mõlemat riiki.
exec "$(dirname -- "${BASH_SOURCE[0]}")/build-official-depth.sh" "$@"
