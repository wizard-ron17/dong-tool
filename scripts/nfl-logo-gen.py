# Ron's Tud Tool logo: Ron's football (10/7). Writes icons/nfl-logo.svg; then run
# scripts/make-nfl-icons.sh for the favicons and app icons, and paste the <g> into
# nfl/index.html's .brand-football. Drawn upright, then turned so the tips point
# up-right / down-left: white ball, grey rim, a green seam from tip to tip that
# tapers to both ends and bows left, five laces across it.
import os
L, W = 28.5, 17.6          # half length, half width (W/L sets how round the ball is)
CX, CY, ANG = 32, 32, 34   # centre, clockwise turn
d = lambda v: f"{v:.2f}"
k = 1.33                   # cubic factor for a pointed ellipse
ball = (f"M0,{d(-L)} C{d(W*k)},{d(-L*0.55)} {d(W*k)},{d(L*0.55)} 0,{d(L)} "
        f"C{d(-W*k)},{d(L*0.55)} {d(-W*k)},{d(-L*0.55)} 0,{d(-L)} Z")
cx, th = -0.78*W, 2.1      # the seam's bow and its thickness at the middle
seam = f"M0,{d(L*0.93)} Q{d(cx-th)},0 0,{d(-L*0.93)} Q{d(cx+th)},0 0,{d(L*0.93)} Z"
def seam_x(y):
    t = (1 - y/(L*0.93)) / 2
    return 2*t*(1-t)*cx
laces = []
ys = [-0.60, -0.43, -0.26, -0.09, 0.08]
for i, f in enumerate(ys):
    y = f*L; x = seam_x(y)
    half = 0.27*W if 0 < i < 4 else 0.30*W     # the end laces a touch longer
    laces.append(f'<path d="M{d(x-half)},{d(y+0.6)} Q{d(x)},{d(y-1.2)} {d(x+half)},{d(y+0.6)}"/>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <!-- Ron's Tud Tool: Ron's football (scripts/nfl-logo-gen.py) - white ball, grey rim,
       a green seam that tapers to both tips and five laces across it -->
  <g transform="translate({CX} {CY}) rotate({ANG})">
    <path d="{ball}" fill="#ffffff" stroke="#b6bcc2" stroke-width="1.9" stroke-linejoin="round"/>
    <path d="{seam}" fill="#66bc07"/>
    <g fill="none" stroke="#66bc07" stroke-width="2.6" stroke-linecap="butt">{''.join(laces)}</g>
  </g>
</svg>
'''
open(os.path.join(os.path.dirname(__file__), '..', 'icons', 'nfl-logo.svg'), 'w').write(svg)
