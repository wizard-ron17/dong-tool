#!/bin/bash
# Regenerate the Goal Tool icon set from Ron's puck drawing.
#
# icons/nhl-logo.svg is the only vector kept in the repo; every PNG below is
# derived from it. Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
#
# Two things this does that a plain export would not:
#  * SQUARE CROP. The drawing sits in a 485x514 canvas with padding around it,
#    so at favicon sizes most of the tile would be empty. The art's own tight
#    box is 426x367 at (31, 79.5); we square that on its centre with 6% air.
#  * The mark is shipped to the topbar as a 96px PNG, not as the SVG. The SVG is
#    235 KB (54 KB brotli) because the knurled side wall is thousands of path
#    segments — none of which survive at 32px. The PNG is 10 KB and identical
#    on screen. (See the "13 MB of images to draw 40px circles" fix in /nfl.)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=icons/nhl-logo.svg
VB="18.2 37.2 451.6 451.6"          # the squared box, in the source's viewBox units

SQ=$(mktemp -t nhlsq).svg
{ echo "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"$VB\" width=\"512\" height=\"512\">"
  grep -o '<path[^>]*/>' "$SRC"
  echo '</svg>'; } > "$SQ"

MK=$(mktemp -t nhlmk).svg
{ echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">'
  echo '<rect width="512" height="512" fill="#0c1526"/>'
  echo '<g transform="translate(256 256) scale(0.68024) translate(-244.0 -263.0)">'
  grep -o '<path[^>]*/>' "$SRC"
  echo '</g></svg>'; } > "$MK"

for s in 16 32 48; do rsvg-convert -w $s -h $s "$SQ" -o icons/nhl-favicon-$s.png; done
for s in 192 512; do rsvg-convert -w $s -h $s "$SQ" -o icons/nhl-icon-$s.png; done
rsvg-convert -w 180 -h 180 "$SQ" -o icons/nhl-apple-touch-icon.png
rsvg-convert -w  96 -h  96 "$SQ" -o icons/nhl-mark-96.png      # the topbar mark
for s in 192 512; do rsvg-convert -w $s -h $s "$MK" -o icons/nhl-icon-maskable-$s.png; done
magick icons/nhl-favicon-16.png icons/nhl-favicon-32.png icons/nhl-favicon-48.png icons/nhl-favicon.ico
rm -f "$SQ" "$MK"
echo "Regenerated:"; ls -la icons/nhl-* | awk '{printf "  %-34s %8s\n",$9,$5}'
