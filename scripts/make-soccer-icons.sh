#!/bin/bash
# Regenerate the Goal Tool (soccer) icon set from the ball in soccer/index.html's topbar.
#
# icons/soccer-logo.svg is the only vector kept; every PNG below is derived from
# it. It is the topbar's own ball (scripts/soccer-ball.py draws both; keep them in step).
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
# The maskable pair sits the ball in the safe zone on the app's dark tile.
# Favicons get a dark ring outside the green rim, as the Hoop Tool's do: at
# 16-32px a white ball on a light browser tab needs an edge.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=icons/soccer-logo.svg
INNER=$(sed -e 's#^<svg[^>]*>##' -e 's#</svg>$##' "$SRC")
MK=$(mktemp -t socmk).svg
{ echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">'
  echo '<rect width="64" height="64" fill="#05080f"/>'
  echo '<g transform="translate(32 32) scale(0.68) translate(-32 -32)">'
  echo "$INNER"
  echo '</g></svg>'; } > "$MK"
FV=$(mktemp -t socfv).svg
{ echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  echo '<circle cx="32" cy="32" r="30" fill="#05080f"/>'
  echo "$INNER"
  echo '</svg>'; } > "$FV"
for s in 16 32 48; do rsvg-convert -w $s -h $s "$FV" -o icons/soccer-favicon-$s.png; done
for s in 192 512; do rsvg-convert -w $s -h $s "$SRC" -o icons/soccer-icon-$s.png; done
rsvg-convert -w 180 -h 180 "$MK" -o icons/soccer-apple-touch-icon.png   # iOS shows transparency as black: use the tile
for s in 192 512; do rsvg-convert -w $s -h $s "$MK" -o icons/soccer-icon-maskable-$s.png; done
magick icons/soccer-favicon-16.png icons/soccer-favicon-32.png icons/soccer-favicon-48.png icons/soccer-favicon.ico
rm -f "$MK" "$FV"
echo "Regenerated:"; ls -la icons/soccer-* | awk '{printf "  %-36s %8s\n",$9,$5}'
echo "Share cards use these icons: now run  python3 scripts/make-og-cards.py  and bump ?v= on the og:image links."
