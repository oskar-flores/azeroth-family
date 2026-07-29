#!/usr/bin/env bash
#
# Create a PRIVATE GitHub repo from this folder and push it.
#
#   ./push-to-github.sh                    -> creates "azeroth-family"
#   ./push-to-github.sh mi-servidor-wow    -> creates that name instead
#
# Uses the GitHub CLI so your credentials stay between you and GitHub.
# I never see or handle a token.

set -euo pipefail

REPO_NAME="${1:-azeroth-family}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m== %s\033[0m\n' "$*"; }

command -v git >/dev/null || die "git is not installed"
command -v gh  >/dev/null || die "GitHub CLI not found. Install it:
    macOS:  brew install gh
    Debian: sudo apt install gh
    or:     https://cli.github.com"

# Log in if needed. This opens a browser; you approve it there.
gh auth status >/dev/null 2>&1 || {
  ok "Not logged in to GitHub. Starting login (a browser window will open)."
  gh auth login
}

# Refuse to push if a filled-in .env somehow slipped past .gitignore.
if git check-ignore -q .env 2>/dev/null; then :; elif [[ -f .env ]]; then
  die ".env exists and is NOT ignored -- it holds your DB password. Fix .gitignore before pushing."
fi

if [[ ! -d .git ]]; then
  ok "Initialising repository"
  git init -q -b main
fi

git add -A
if git diff --cached --quiet; then
  ok "Nothing new to commit"
else
  git -c user.name="${GIT_NAME:-$(git config user.name || echo "$USER")}" \
      -c user.email="${GIT_EMAIL:-$(git config user.email || echo "$USER@localhost")}" \
      commit -q -m "Azeroth family server: playerbots stack for Dokploy"
  ok "Committed $(git rev-list --count HEAD) revision(s)"
fi

if git remote get-url origin >/dev/null 2>&1; then
  ok "Remote already set: $(git remote get-url origin)"
  git push -u origin main
else
  ok "Creating PRIVATE repo '$REPO_NAME' and pushing"
  gh repo create "$REPO_NAME" --private --source=. --remote=origin --push
fi

echo
ok "Done"
gh repo view --json nameWithOwner,visibility,url \
  --template '{{.nameWithOwner}} ({{.visibility}}){{"\n"}}{{.url}}{{"\n"}}'
echo "Point Dokploy at this repo (it will need access -- add it as a deploy key"
echo "or connect your GitHub account in Dokploy's Git settings)."
