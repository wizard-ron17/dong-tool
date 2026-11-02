#!/usr/bin/env bash
# Commit and push <sport>/*.json if the build changed it.   bash scripts/commit-data.sh nba
# Whole-file regenerates: if a racing push lands first, replay onto the latest main.
# [skip netlify]: a data commit never starts a Netlify build (the pages read data from raw GitHub; netlify.toml's ignore
# would cancel it anyway, but only after starting it: 11/02's runaway watcher started ~2,300 of those).
set -u
sport="$1"
# Circuit breaker: a builder stuck in a loop (11/02: a full NBA build every ~35s for 14 hours) stops here. A normal
# pre-game window pushes about 12 an hour (every 5 minutes); refuse past MAX and fail, which opens a build alert.
MAX=20
git fetch -q --shallow-since="90 minutes ago" origin main 2>/dev/null || git fetch -q origin main
recent=$(git log FETCH_HEAD --since="60 minutes ago" --format=%s | grep -c "^Update $sport/" || true)
if [ "$recent" -ge "$MAX" ]; then
  echo "::error::circuit breaker: $recent $sport data commits in the last hour (max $MAX), not pushing. Something is looping."
  exit 1
fi
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add "$sport"/*.json
git diff --staged --quiet && { echo "No changes to commit"; exit 0; }
git commit -q -m "Update $sport/data.json [skip netlify]"
for attempt in 1 2 3 4 5; do
  if git push -q; then echo "Pushed on attempt $attempt"; exit 0; fi
  echo "Push rejected (attempt $attempt) — replaying onto latest main"
  # back off 5/20/45/80s: a GitHub 500 blip outlasted 3s retries on 10/7
  sleep $((attempt * attempt * 5))
  git fetch -q origin main
  git reset -q FETCH_HEAD
  git add "$sport"/*.json
  git diff --staged --quiet && { echo "Already current with main"; exit 0; }
  git commit -q -m "Update $sport/data.json [skip netlify]"
done
echo "Failed to push after 5 attempts"; exit 1
