#!/usr/bin/env bash
# Build alerts: a failed workflow opens ONE GitHub issue that @-mentions Ron
# (an email and a phone push), and the next green run closes it. Hourly crons
# would otherwise fail silently: NHL's opening-day build broke and nobody knew
# until the site looked wrong.
#   bash scripts/build-alert.sh fail "nhl data"     # in an `if: failure()` step
#   bash scripts/build-alert.sh ok   "nhl data"     # in an `if: success()` step
# Needs GH_TOKEN (the workflow's github.token) and `permissions: issues: write`.
set -u
mode="$1"; what="$2"
title="Build failing: $what"
run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
num=$(gh issue list --state open --limit 50 --json number,title -q ".[] | select(.title == \"$title\") | .number" | head -1)
if [ "$mode" = fail ]; then
  if [ -n "$num" ]; then echo "Alert already open: #$num"; exit 0; fi
  gh issue create --title "$title" --body "@wizard-ron17 the **$GITHUB_WORKFLOW** run failed ($GITHUB_EVENT_NAME): $run

Until it's fixed the site keeps serving the last good data, and this stays open. The next green run closes it on its own (one issue per build, so the hourly crons don't pile up)."
else
  if [ -n "$num" ]; then gh issue close "$num" --comment "Back to green: $run"; else echo "No open alert"; fi
fi
