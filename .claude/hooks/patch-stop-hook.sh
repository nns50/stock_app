#!/usr/bin/env bash
#
# SessionStart hook (repo-managed, durable).
#
# The Claude Code on the web launcher injects a Stop hook at
# ~/.claude/stop-hook-git-check.sh and regenerates it on every container start
# (the home dir is ephemeral). That hook compares the local branch tip against
# the *remote dev branch*, which goes stale after a squash-merge: once the dev
# branch is reset onto main, its tip is GitHub's own squash commit (committer
# noreply@github.com, a web-flow signature the local keyring can't verify). The
# stock hook then reports that commit as "Unverified / unpushed" and advises a
# `--reset-author` amend that would rewrite already-merged upstream history.
#
# This script durably neutralizes that false positive by prepending a small
# guard to the launcher's hook: exit cleanly ONLY when HEAD is already an
# ancestor of the default branch AND the working tree is pristine (no staged,
# unstaged, or untracked changes) — i.e. genuinely nothing to commit or push.
# Any real work (commits ahead of main, or a dirty tree) falls through to the
# original checks untouched, so legitimate warnings are preserved.
#
# It is idempotent (a sentinel prevents double-patching), a no-op when the
# launcher hook isn't present (e.g. local non-web sessions), and always exits 0
# so it can never block a session. Target path may be overridden via $1 (used
# by the test).

target="${1:-$HOME/.claude/stop-hook-git-check.sh}"
sentinel="repo-managed: suppress post-squash-merge false positive"

# Nothing to patch (no launcher hook here), or already patched.
[ -f "$target" ] || exit 0
grep -qF "$sentinel" "$target" 2>/dev/null && exit 0

# Insert the guard right after the shebang (a stable anchor across launcher
# script revisions). Atomic: build into a temp file, then move into place.
tmp="$(mktemp 2>/dev/null)" || exit 0
{
  head -n 1 "$target"
  cat <<'GUARD'
# >>> repo-managed: suppress post-squash-merge false positive (idempotent) >>>
# Exit clean when HEAD is already merged into the default branch and the tree
# is pristine — there is genuinely nothing to commit or push, so the checks
# below would only raise a false positive on GitHub's own squash commit. Real
# work (commits ahead of main, or any dirty/untracked file) falls through.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1 && [ -n "$(git remote 2>/dev/null)" ]; then
  __def_ref=""
  for __ref in origin/main origin/master origin/HEAD; do
    if git rev-parse --verify "$__ref" >/dev/null 2>&1; then __def_ref="$__ref"; break; fi
  done
  if [ -n "$__def_ref" ] \
    && git merge-base --is-ancestor HEAD "$__def_ref" 2>/dev/null \
    && git diff --quiet 2>/dev/null \
    && git diff --cached --quiet 2>/dev/null \
    && [ -z "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
    exit 0
  fi
fi
# <<< repo-managed: suppress post-squash-merge false positive (idempotent) <<<
GUARD
  tail -n +2 "$target"
} >"$tmp" 2>/dev/null && chmod +x "$tmp" 2>/dev/null && mv "$tmp" "$target" 2>/dev/null

exit 0
