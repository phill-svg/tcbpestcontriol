#!/bin/bash
# Installs the plugins enabled in .claude/settings.json so their skills are
# available in Claude Code on the web sessions. Safe to re-run.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

add_marketplace() {
  claude plugin marketplace add "$1" >/dev/null 2>&1 \
    || echo "session-start: marketplace $1 not added (may already exist)" >&2
}

install_plugin() {
  claude plugin install "$1" >/dev/null 2>&1 \
    || echo "session-start: plugin $1 not installed (may already exist)" >&2
}

add_marketplace anthropics/claude-plugins-official
add_marketplace obra/superpowers-marketplace
add_marketplace JuliusBrussee/caveman

install_plugin frontend-design@claude-plugins-official
install_plugin superpowers@superpowers-marketplace
install_plugin caveman@caveman

exit 0
