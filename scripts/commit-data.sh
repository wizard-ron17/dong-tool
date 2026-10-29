#!/usr/bin/env bash
# Commit and push <sport>/*.json if the build changed it.   bash scripts/commit-data.sh nba
# Whole-file regenerates: if a racing push lands first, replay onto the latest main.
set -u
sport="$1"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add "$sport"/*.json
git diff --staged --quiet && { echo "No changes to commit"; exit 0; }
git commit -q -m "Update $sport/data.json"
for attempt in 1 2 3 4 5; do
  if git push -q; then echo "Pushed on attempt $attempt"; exit 0; fi
  echo "Push rejected (attempt $attempt) — replaying onto latest main"
  # back off 5/20/45/80s: a GitHub 500 blip outlasted 3s retries on 10/7
  sleep $((attempt * attempt * 5))
  git fetch -q origin main
  git reset -q FETCH_HEAD
  git add "$sport"/*.json
  git diff --staged --quiet && { echo "Already current with main"; exit 0; }
  git commit -q -m "Update $sport/data.json"
done
echo "Failed to push after 5 attempts"; exit 1
