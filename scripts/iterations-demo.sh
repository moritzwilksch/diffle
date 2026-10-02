#!/usr/bin/env bash
# Walk the fixture repository through the history rewrites a reviewer sees between pushes, one
# at a time: build it, print the diffle command to open it with, then after every Enter rewrite
# feature/refunds and print what git's own range-diff makes of it. In diffle, press Reload after
# each step and compare the new iteration with an older one.
#
#   scripts/iterations-demo.sh [dir]            interactive, from a fresh fixture
#   scripts/iterations-demo.sh <dir> prepare     build the fixture only
#   scripts/iterations-demo.sh <dir> <n>         run push n (1-9) on it, without waiting
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=${1:-$(mktemp -d "${TMPDIR:-/tmp}/diffle-iterations.XXXXXX")}
ONLY=${2:-}
TOOLS=$(mktemp -d "${TMPDIR:-/tmp}/diffle-iterations-tools.XXXXXX")
trap 'rm -rf "$TOOLS"' EXIT

prepare() {
  (cd "$ROOT" && npm run fixture -- "$DIR" >/dev/null)
  cd "$DIR"
  # The fixture's staged and unstaged state is for working mode; rebases and amends need a clean tree.
  git reset -q --hard && git clean -fdq
  git config user.name 'Grace Hopper'
  git config user.email grace@example.com
}
if [ -z "$ONLY" ] || [ "$ONLY" = prepare ]; then prepare; fi
cd "$DIR"
export GIT_EDITOR=true

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
log() { git log --format='   %h %s' main..feature/refunds; }
range() { echo "$(git merge-base main feature/refunds)..$(git rev-parse feature/refunds)"; }
pause() {
  [ -n "${SKIP:-}" ] && return 0
  printf '\n   In diffle: %s\n' "$1"
  [ -z "$ONLY" ] && read -r -p '   Enter for the next push… '
  return 0
}

# Sequence editors for `rebase -i`: tiny scripts, since the editor runs under sh with the todo file appended.
cat >"$TOOLS/mark" <<'EOF'
#!/bin/sh
# mark <action> <subject pattern> <todo>: turn the matching pick into <action>.
sed -i.bak "/$2/s/^pick/$1/" "$3"
EOF
cat >"$TOOLS/last-first" <<'EOF'
#!/bin/sh
# Move the last pick to the top of the todo list.
awk '/^pick/ { p[++n] = $0; next } { o[++m] = $0 } END { print p[n]; for (i = 1; i < n; i++) print p[i]; for (i = 1; i <= m; i++) print o[i] }' "$1" >"$1.new"
mv "$1.new" "$1"
EOF
chmod +x "$TOOLS"/*

if [ "$ONLY" = prepare ]; then
  echo "npm run dev -- -C $DIR main...feature/refunds --no-open"
  exit 0
fi
if [ -z "$ONLY" ]; then
  bold "Fixture at $DIR"
  echo "   npm run dev -- -C $DIR main...feature/refunds --no-open"
  log
  pause 'open it; iteration #1 is recorded as soon as the review loads.'
fi
# In single-step mode only push $ONLY runs; `step` numbers them in order.
N=0
step() {
  N=$((N + 1))
  if [ -n "$ONLY" ] && [ "$ONLY" != "$N" ]; then
    SKIP=1
    return 0
  fi
  SKIP=
  local title=$1 before
  shift
  before=$(range)
  bold "$title"
  "$@"
  echo '   range-diff, previous push → this one:'
  # The same creation factor diffle uses, so the pairing matches what it shows.
  git range-diff -s --no-color --creation-factor=100 "$before" "$(range)" | sed 's/^/     /'
}

reword() {
  git commit -q --amend -m 'fix(cli): say so instead of crashing on an empty ledger' \
    -m 'An empty ledger is a usage mistake, not a bug; exit 1 with a one-line message.'
  log
}
step '1. Reword the tip commit' reword
pause 'Reload. The interdiff is empty; the pair reads "reworded" and shows the previous message.'

rebase_with_conflict() {
  if ! git rebase -q main >/dev/null 2>&1; then
    echo "   conflict in $(git diff --name-only --diff-filter=U); resolving: keep the kind column, add main's quantity check"
    # Stage 3 is the branch's version of the file; main's check goes in next to the kind check.
    git show :3:tally/ledger.py >tally/ledger.py
    perl -0pi -e '
      s/(        raise ValueError\(f"unknown kind: \{kind!r\}"\)\n)/$1    quantity = int(row["quantity"])\n    if quantity < 0:\n        raise ValueError(f"negative quantity for {row[\x27description\x27]!r}: {quantity}")\n/;
      s/quantity=int\(row\["quantity"\]\),/quantity=quantity,/' tally/ledger.py
    git add tally/ledger.py
    git rebase --continue >/dev/null
  fi
  log
}
step '2. Rebase onto main, resolving a conflict in tally/ledger.py' rebase_with_conflict
pause 'Reload. The base moved; the interdiff shows only the conflict resolution in ledger.py, not main'"'"'s fix. One pair is "amended".'

cherry_pick() {
  git checkout -q -b colleague/kind-docs main
  perl -0pi -e 's/(A ledger is a CSV file with the columns[^\n]*\n)/$1`kind` is optional and is `sale` unless it says `refund`.\n/' README.md
  GIT_AUTHOR_NAME='Ada Lovelace' GIT_AUTHOR_EMAIL=ada@example.com git commit -q -am 'docs: document the kind column'
  git checkout -q feature/refunds
  git cherry-pick colleague/kind-docs >/dev/null
  git branch -q -D colleague/kind-docs
  log
}
step "3. Cherry-pick a colleague's commit onto the branch" cherry_pick
pause 'Reload. One "added" pair; the interdiff is that commit alone.'

drop() {
  GIT_SEQUENCE_EDITOR="$TOOLS/mark drop 'regenerate the client'" git rebase -q -i main
  log
}
step '4. Drop the regenerate-the-client commit' drop
pause 'Reload. One "dropped" pair, listed but not openable; the interdiff removes its files.'

edit_middle() {
  GIT_SEQUENCE_EDITOR="$TOOLS/mark edit 'support refund lines'" git rebase -q -i main >/dev/null 2>&1
  perl -pi -e 's/unknown kind: \{kind!r\}/unknown kind {kind!r}: expected sale or refund/' tally/ledger.py
  git commit -q --amend --no-edit -a
  git rebase --continue >/dev/null
  log
}
step '5. Edit the first commit: a better error message' edit_middle
pause 'Reload. The first pair is "amended"; opening it shows the one-line change, the later commits stay identical.'

fixup() {
  perl -pi -e 's/print\("no entries", file=sys.stderr\)/print("no entries in the given ledgers", file=sys.stderr)/' tally/cli.py
  git commit -q -a --fixup HEAD~1
  log
}
step '6. Push a fixup! commit for the cli fix' fixup
pause 'Reload. An "added" pair at the tip: the review can go on before the branch is tidied.'

autosquash() {
  GIT_SEQUENCE_EDITOR=true git rebase -q -i --autosquash main
  log
}
step '7. Autosquash the fixup into its commit' autosquash
pause 'Reload. The fixup is "dropped", the cli fix "amended"; the interdiff is empty: nothing changed in content.'

reorder() {
  GIT_SEQUENCE_EDITOR="$TOOLS/last-first" git rebase -q -i main
  log
}
step '8. Reorder: move the docs commit to the start' reorder
pause 'Reload. Every pair is "identical" at a new position; the interdiff is empty.'

merge_main() {
  git checkout -q main
  printf '# Changelog\n\n## Unreleased\n\n- Reject negative quantities.\n' >CHANGELOG.md
  git add CHANGELOG.md
  git commit -q -m 'docs: start a changelog'
  git checkout -q feature/refunds
  git merge -q --no-edit main
  log
}
step '9. main moves on and is merged into the branch' merge_main
pause 'Reload. The merge base moved to main'"'"'s tip; the interdiff is empty and the merge commit is not a range-diff pair.'

if [ -z "$ONLY" ]; then
  bold 'Done.'
  echo "   The repository stays at $DIR."
fi
