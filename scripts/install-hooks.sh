#!/bin/sh
# Install the repository's Git hooks into .git/hooks/.
#
# A copy, not `git config core.hooksPath .githooks`. core.hooksPath resolves
# against the WORKING TREE, so a tracked hook is only present while a branch
# containing it is checked out — it would be missing on main, the branch the
# pre-commit hook exists to protect. Verified: with core.hooksPath set, a
# commit straight to main went through unblocked.
#
# Re-run after pulling changes to .githooks/.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

for hook in .githooks/*; do
    [ -f "$hook" ] || continue
    name=$(basename "$hook")
    cp "$hook" ".git/hooks/$name"
    chmod +x ".git/hooks/$name"
    echo "installed .git/hooks/$name"
done
