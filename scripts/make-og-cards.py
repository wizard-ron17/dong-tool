"""Share cards (1200x630) for link previews — iMessage, X, Facebook, Slack, Discord.

    python3 scripts/make-og-cards.py          # -> icons/og-{root,mlb,nfl,nhl,nba}.png

Each card is the app's own look (its logo, Chakra Petch / Plus Jakarta / JetBrains
Mono, the green accent on the dark page) rendered in headless Chromium at the
size every platform's large preview wants. Regenerate when an app's tool list
changes — the chips list what it prices. Needs: pip install playwright.
"""
import os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "icons")
CARDS = {
    "mlb": ("MLB", "Ron's", "Dong", "Tool", "icon-512.png",
            "Home run picks, strikeouts, walks and steals. Every matchup scored.",
            ["Home runs", "Strikeouts", "Walks", "Steals", "Matchup Lab", "Playoffs"]),
    "nfl": ("NFL", "Ron's", "Tud", "Tool", "nfl-icon-512.png",
            "Touchdowns, yards, receptions and passing. Every line priced.",
            ["Anytime TD", "Yards", "Receptions", "Completions", "Kickers", "Fantasy"]),
    "nhl": ("NHL", "Ron's", "Goal", "Tool", "nhl-icon-512.png",
            "Goals, points, shots, saves, hits and blocks. Every line priced.",
            ["Goals", "Points", "Shots", "Saves", "Hits", "Blocks"]),
    "nba": ("NBA", "Ron's", "Hoop", "Tool", "nba-icon-512.png",
            "Threes, points, rebounds, assists and first basket. Every line priced.",
            ["Threes", "Points", "PRA", "Steals & Blocks", "Doubles", "First Basket"]),
}
FONTS = ('<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=JetBrains+Mono:wght@600'
         '&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet">')
CSS = """
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; overflow: hidden; background: #05080f; color: #e8edf5; font-family: 'Plus Jakarta Sans', sans-serif; }
  .card { position: relative; width: 1200px; height: 630px; padding: 70px 80px; display: flex; flex-direction: column; justify-content: space-between;
    background: radial-gradient(900px 520px at 0% 0%, rgba(51,208,124,0.20), transparent 60%),
                radial-gradient(700px 500px at 100% 100%, rgba(51,208,124,0.08), transparent 60%), #05080f; }
  .card::before { content: ''; position: absolute; inset: 0; opacity: 0.35;
    background-image: linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 60px 60px; mask-image: linear-gradient(90deg, #000, transparent 75%); }
  .top { position: relative; display: flex; align-items: center; gap: 44px; }
  .logo { width: 200px; height: 200px; object-fit: contain; filter: drop-shadow(0 14px 40px rgba(0,0,0,0.55)); }
  .eyebrow { font: 700 26px 'Chakra Petch'; letter-spacing: 0.22em; color: #33d07c; }
  h1 { font: 700 94px/1 'Chakra Petch'; letter-spacing: -0.01em; margin: 10px 0 18px; color: #fff; }
  h1 em { font-style: normal; color: #33d07c; }
  .tag { font: 600 30px/1.3 'Plus Jakarta Sans'; color: #b7c1d1; max-width: 760px; }
  .chips { position: relative; display: flex; flex-wrap: wrap; gap: 12px; }
  .chip { font: 700 22px 'Plus Jakarta Sans'; color: #dfe7f1; padding: 10px 20px; border-radius: 999px;
    background: rgba(255,255,255,0.05); border: 1.5px solid rgba(255,255,255,0.12); }
  .foot { position: relative; display: flex; justify-content: space-between; align-items: center;
    font: 600 22px 'JetBrains Mono'; color: #7d889c; }
  .foot b { color: #33d07c; font-weight: 600; }
  .logos { display: flex; gap: 26px; }
  .logos img { width: 118px; height: 118px; object-fit: contain; }
"""


def page(body):
    return f"<!doctype html><html><head><meta charset='utf-8'>{FONTS}<style>{CSS}</style></head><body>{body}</body></html>"


def sport_card(key):
    sport, a, b, c, logo, tag, chips = CARDS[key]
    return page(f"""<div class="card">
      <div class="top"><img class="logo" src="file://{ICONS}/{logo}">
        <div><div class="eyebrow">{sport} · PLAYER PROPS</div><h1>{a} <em>{b}</em> {c}</h1><div class="tag">{tag}</div></div></div>
      <div class="chips">{''.join(f'<span class="chip">{x}</span>' for x in chips)}</div>
      <div class="foot"><span><b>dong-tool.netlify.app</b>/{key}</span><span>Fair odds, no vig · Inspired by Green Means Go</span></div>
    </div>""")


def root_card():
    logos = "".join(f'<img src="file://{ICONS}/{CARDS[k][4]}">' for k in ("mlb", "nfl", "nhl", "nba"))
    return page(f"""<div class="card">
      <div class="top"><div><div class="eyebrow">MLB · NFL · NHL · NBA</div><h1>Ron's <em>Tools</em></h1>
        <div class="tag">Every player prop priced: home runs, touchdowns, goals and threes, with parlays and line movement.</div></div></div>
      <div class="logos">{logos}</div>
      <div class="foot"><span><b>dong-tool.netlify.app</b></span><span>Fair odds, no vig · Inspired by Green Means Go</span></div>
    </div>""")


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1200, "height": 630})
        for key, html in [("root", root_card())] + [(k, sport_card(k)) for k in CARDS]:
            tmp = os.path.join(ICONS, f".og-{key}.html")
            open(tmp, "w").write(html)
            pg.goto(f"file://{tmp}"); pg.wait_for_timeout(1200)            # web fonts
            out = os.path.join(ICONS, f"og-{key}.png")
            pg.screenshot(path=out, clip={"x": 0, "y": 0, "width": 1200, "height": 630})
            os.remove(tmp)
            print(f"wrote {out} ({os.path.getsize(out) // 1024} KB)")
        b.close()


if __name__ == "__main__":
    main()
