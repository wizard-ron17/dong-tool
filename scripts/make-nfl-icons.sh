#!/bin/bash
# Regenerate the Tud Tool icon set from icons/nfl-logo.svg — Ron's football (white,
# grey rim, green laces and seam), drawn by scripts/nfl-logo-gen.py.
# The topbar inlines the same drawing (nfl/index.html .brand-football).
# App icons are transparent, like the other three sports'; only the
# platforms that need a tile get one (apple-touch: iOS paints transparency
# black; maskable: Android crops to its own shape). Favicons get a dark rim
# so the white ball reads on a light browser tab.
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=icons/nfl-logo.svg
BODY=$(sed -n '/<g /,/^  <\/g>/p' "$SRC")   # to the outer group's close: the laces nest a <g>
# favicons: the ball's own outline in a dark rim, so the white reads on a light tab
RIM=$(printf '%s' "$BODY" | sed 's#stroke="\#b6bcc2" stroke-width="1.9"#stroke="\#05080f" stroke-width="3.5"#')
{ echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'; printf '%s\n' "$RIM"; echo '</svg>'; } > icons/nfl-favicon.svg
MK=$(mktemp -t nflmk).svg
{ echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512"><rect width="64" height="64" fill="#05080f"/>'
  echo '<g transform="translate(32 32) scale(0.72) translate(-32 -32)">'; printf '%s\n' "$BODY"; echo '</g></svg>'; } > "$MK"
for s in 16 32 48; do rsvg-convert -w $s -h $s icons/nfl-favicon.svg -o icons/nfl-favicon-$s.png; done
for s in 192 512; do rsvg-convert -w $s -h $s "$SRC" -o icons/nfl-icon-$s.png; done
rsvg-convert -w 180 -h 180 "$MK" -o icons/nfl-apple-touch-icon.png
for s in 192 512; do rsvg-convert -w $s -h $s "$MK" -o icons/nfl-icon-maskable-$s.png; done
magick icons/nfl-favicon-16.png icons/nfl-favicon-32.png icons/nfl-favicon-48.png icons/nfl-favicon.ico
rm -f "$MK"
echo "Regenerated:"; ls -la icons/nfl-* | awk '{printf "  %-34s %8s\n",$9,$5}'
