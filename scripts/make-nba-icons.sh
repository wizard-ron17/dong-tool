#!/bin/bash
# Regenerate the Hoop Tool icon set from the ball in nba/index.html's topbar.
#
# icons/nba-logo.svg is the only vector kept; every PNG below is derived from it.
# It is the topbar's own ball (keep the two in step), seams clipped to the ball.
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
# The maskable pair sits the ball in the safe zone on the app's dark tile.
# Favicons get a dark rim: at 16-32px a white ball on a light browser tab is
# just floating green seams.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=icons/nba-logo.svg
MK=$(mktemp -t nbamk).svg
{ echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">'
  echo '<rect width="64" height="64" fill="#05080f"/>'
  echo '<g transform="translate(32 32) scale(0.68) translate(-32 -32)">'
  sed -n '/<defs>/,/<\/g>/p' "$SRC"
  echo '</g></svg>'; } > "$MK"
FV=$(mktemp -t nbafv).svg
sed 's#<circle cx="32" cy="32" r="29" fill="\#ffffff"/>#<circle cx="32" cy="32" r="29.5" fill="\#ffffff" stroke="\#05080f" stroke-width="4"/>#' "$SRC" > "$FV"
for s in 16 32 48; do rsvg-convert -w $s -h $s "$FV" -o icons/nba-favicon-$s.png; done
for s in 192 512; do rsvg-convert -w $s -h $s "$SRC" -o icons/nba-icon-$s.png; done
rsvg-convert -w 180 -h 180 "$MK" -o icons/nba-apple-touch-icon.png   # iOS shows transparency as black: use the tile
for s in 192 512; do rsvg-convert -w $s -h $s "$MK" -o icons/nba-icon-maskable-$s.png; done
magick icons/nba-favicon-16.png icons/nba-favicon-32.png icons/nba-favicon-48.png icons/nba-favicon.ico
rm -f "$MK" "$FV"
echo "Regenerated:"; ls -la icons/nba-* | awk '{printf "  %-34s %8s\n",$9,$5}'
