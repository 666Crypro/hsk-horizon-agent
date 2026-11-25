#!/usr/bin/env python3
"""Compose docs/demo.mp4 (1080p H.264 + AAC, Piper narration) from REAL captured output.

Inputs (all produced by running the project locally, nothing typed by hand):
  docs/demo-logs/forge-unit.txt   forge test --color always
  docs/demo-logs/forge-fork.txt   HSK_FORK=1 forge test --match-contract Fork -vv
  docs/demo-logs/npm-test.txt     cd agent && npm test
  docs/demo-logs/demo.txt         KEEP_FORK=1 DEMO_PAUSE_MS=200 npm run demo   (Anvil fork of HSK mainnet)
  docs/dashboard.png              npm run dashboard, screenshot after the demo
  docs/arch.png                   README mermaid diagram rendered in headless Chrome

    PIPER=/path/to/piper VOICE=/path/to/en_US-lessac-medium.onnx python3 scripts/demo-video.py
"""
from __future__ import annotations
import os, re, subprocess, wave, shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
LOGS = ROOT / "docs" / "demo-logs"
OUT = ROOT / "docs" / "demo.mp4"
WORK = Path(os.environ.get("DEMO_WORK", "/workspace/hsk-video-work/build-frames"))
PIPER = os.environ.get("PIPER", "/workspace/tools-video/piper/piper")
VOICE = os.environ.get("VOICE", "/workspace/tools-video/en_US-lessac-medium.onnx")
W, H = 1920, 1080
LEAD, TAIL = 0.1, 0.25   # extra silence around each narration clip (Piper adds ~0.2 s itself; gaps stay under 1 s)

GF = "/usr/share/fonts/truetype/sand-box/google"
INTER = f"{GF}/Inter/Inter-VariableFont_opsz,wght.ttf"
MONO = f"{GF}/JetBrains Mono/JetBrainsMono-VariableFont_wght.ttf"
FALLBACK = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO_CMAP = TTFont(MONO).getBestCmap()

def font(path, size, wght=None):
    f = ImageFont.truetype(path, size)
    if wght is not None:
        try:
            f.set_variation_by_axes([wght] if path == MONO else [14, wght])
        except Exception:
            pass
    return f

BG = (11, 15, 23); PANEL = (21, 27, 38); BORDER = (38, 48, 65)
FG = (230, 237, 243); DIM = (139, 148, 158); CYAN = (88, 196, 220); GREEN = (63, 185, 80)
RED = (248, 81, 73); YELLOW = (227, 179, 65); BLUE = (88, 166, 255)

# ---------------------------------------------------------------- logs
def read(name):
    return (LOGS / name).read_text().splitlines()

demo = read("demo.txt")
def section(start, end=None):
    i = next(k for k, l in enumerate(demo) if l.startswith(f"== {start}."))
    j = len(demo) if end is None else next(k for k, l in enumerate(demo) if l.startswith(f"== {end}."))
    out = demo[i:j]
    while out and not out[-1].strip():
        out.pop()
    return out

_u = read("forge-unit.txt"); _u = _u[next(k for k, l in enumerate(_u) if l.startswith("Ran 22")):]
unit = [l for l in _u if l.startswith(("[PASS]", "Suite result", "Ran 22"))][:24]
unit = [re.sub(r" \((gas|runs).*\)$", "", l) if l.startswith("[PASS]") else l for l in unit]
unit = [l for l in unit if "test_Fork" not in l]
fork = [l for l in read("forge-fork.txt") if l.strip() and not l.startswith(("No files", "Ran 1 test suite"))]
npmt = [l for l in read("npm-test.txt") if l.startswith(("✔", "ℹ tests", "ℹ pass", "ℹ fail"))]

def color_for(line):
    s = line.strip()
    if s.startswith("=="): return CYAN
    if s.startswith("you>"): return YELLOW
    if "REVERTED" in s or "REFUSED" in s or "refused" in s or s.startswith("-> the vault"): return RED
    if s.startswith(("filled", "[PASS]", "✔", "Suite result", "Demo complete")) or "STOP-LOSS executed" in s or "verified:" in s: return GREEN
    if s.startswith(("$", "#")): return BLUE if s.startswith("$") else FG
    if s.startswith(("journal", "reasonHash")): return DIM
    return FG

# ---------------------------------------------------------------- drawing
F_MONO = {}
def mono(size, bold=False):
    k = (size, bold)
    if k not in F_MONO:
        F_MONO[k] = (font(MONO, size, 700 if bold else 430), ImageFont.truetype(FALLBACK, int(size * 0.9)))
    return F_MONO[k]

def draw_mono(d, xy, text, size, fill, bold=False):
    f, fb = mono(size, bold)
    x, y = xy
    cw = f.getlength("M")
    for ch in text:
        if ord(ch) in MONO_CMAP or ch == " ":
            d.text((x, y), ch, font=f, fill=fill)
        else:
            d.text((x, y + 1), ch, font=fb, fill=fill)
        x += cw

def wrap(line, maxc):
    if len(line) <= maxc:
        return [line]
    ind = len(line) - len(line.lstrip()) + 4
    out, cur = [], line
    while len(cur) > maxc:
        cut = cur.rfind(" ", 0, maxc)
        if cut <= ind:
            cut = maxc
        out.append(cur[:cut]); cur = " " * ind + cur[cut:].lstrip()
    out.append(cur)
    return out

def header(d, kicker, title):
    d.text((64, 34), kicker.upper(), font=font(INTER, 22, 700), fill=CYAN)
    d.text((64, 62), title, font=font(INTER, 40, 700), fill=FG)

def window(img, box, title):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, 14, fill=PANEL, outline=BORDER, width=2)
    d.rounded_rectangle((x0, y0, x1, y0 + 42), 14, fill=(30, 37, 50))
    d.rectangle((x0, y0 + 28, x1, y0 + 42), fill=(30, 37, 50))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse((x0 + 18 + i * 24, y0 + 14, x0 + 32 + i * 24, y0 + 28), fill=c)
    d.text((x0 + 100, y0 + 10), title, font=font(INTER, 20, 500), fill=DIM)
    return (x0 + 24, y0 + 60, x1 - 24, y1 - 16)

def term_frame(kicker, title, panes, shown):
    """panes: list of (box, wintitle, lines, size). shown: number of visual lines revealed, across panes in order."""
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    header(d, kicker, title)
    left = shown
    for box, wt, lines, size in panes:
        ix0, iy0, ix1, iy1 = window(img, box, wt)
        f, _ = mono(size)
        maxc = int((ix1 - ix0) / f.getlength("M"))
        vis = [(seg, color_for(l), l.strip().startswith("==")) for l in lines for seg in wrap(l, maxc)]
        lh = int(size * 1.38)
        for k, (seg, c, b) in enumerate(vis[: max(0, left)]):
            draw_mono(d, (ix0, iy0 + k * lh), seg, size, c, bold=b)
        assert iy0 + len(vis) * lh <= iy1 + 4, f"overflow in {title}: {len(vis)} lines"
        left -= len(vis)
    return img

def count_vis(panes):
    n = 0
    for box, wt, lines, size in panes:
        f, _ = mono(size); maxc = int((box[2] - box[0] - 48) / f.getlength("M"))
        n += sum(len(wrap(l, maxc)) for l in lines)
    return n

def card(lines):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    total = sum(h for _, _, _, h in lines)
    y = (H - total) // 2
    for text, f, c, h in lines:
        if text:
            tw = d.textlength(text, font=f)
            d.text(((W - tw) / 2, y), text, font=f, fill=c)
        y += h
    return img

def image_frame(kicker, title, path, wintitle, crop_bg=True):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    header(d, kicker, title)
    ix0, iy0, ix1, iy1 = window(img, (60, 140, 1860, 1040), wintitle)
    src = Image.open(path).convert("RGB")
    if crop_bg:
        bgpx = src.getpixel((2, 2))
        mask = Image.eval(src.convert("L"), lambda v: 255 if abs(v - sum(bgpx) / 3) > 6 else 0)
        bb = mask.getbbox()
        if bb:
            pad = 16
            src = src.crop((max(0, bb[0] - pad), max(0, bb[1] - pad), min(src.width, bb[2] + pad), min(src.height, bb[3] + pad)))
    s = min((ix1 - ix0) / src.width, (iy1 - iy0) / src.height)
    src = src.resize((int(src.width * s), int(src.height * s)), Image.LANCZOS)
    img.paste(src, (ix0 + (ix1 - ix0 - src.width) // 2, iy0 + (iy1 - iy0 - src.height) // 2))
    return img

# ---------------------------------------------------------------- scenes
DEMO_WIN = "agent — KEEP_FORK=1 npm run demo   (local Anvil fork of HSK Chain mainnet · Anvil test accounts, no real funds)"
FULL = (60, 140, 1860, 1040)
T1, T2 = font(INTER, 96, 800), font(INTER, 40, 500)
T3, T4 = font(INTER, 30, 500), font(INTER, 26, 400)

SCENES = [
    dict(kind="card", lines=[("HSK Sentinel", T1, FG, 130),
                             ("An AI trading agent for HSKSwap that cannot blow up your wallet", T2, CYAN, 80),
                             ("HSK Chain Horizon Hackathon  ·  AI Agent Trading track", T3, DIM, 50)],
         vo="Most AI trading agents keep their risk limits inside the bot. If the model hallucinates a trade size, "
            "or the server dies during a crash, you eat the loss. H S K Sentinel moves those limits onto H S K Chain, "
            "into a vault that the agent cannot override."),
    dict(kind="image", kicker="Architecture", title="The agent decides. The vault on HSK Chain enforces the limits.",
         path="docs/arch.png", wintitle="README.md — architecture",
         vo="A human owner funds the vault and sets the policy: trade size, a daily cap, slippage measured against the time weighted average price, "
            "a manipulation guard, maximum exposure, a drawdown breaker, and a stop-loss. The AI agent holds a hot key that can only call trade. "
            "Anyone can trigger the stop, and every decision is hashed on-chain."),
    dict(kind="term", kicker="Tests · run locally", title="22 unit + fuzz tests, and a fork test on the real HSKSwap pool",
         panes=[((60, 140, 930, 1040), "contracts — forge test", ["$ forge test"] + unit, 17),
                ((960, 140, 1860, 1040), "contracts — HSK_FORK=1 forge test --match-contract Fork -vv",
                 ["$ HSK_FORK=1 forge test --match-contract Fork -vv"] + fork + ["", "$ cd ../agent && npm test"] + npmt, 16)],
         vo="Everything in this video ran locally. Twenty-two Foundry unit and fuzz tests pass. The fork test runs the full lifecycle "
            "against the real pool on H S K Swap, using a fork of H S K Chain mainnet. The six agent tests pass too."),
    dict(kind="term", kicker="Demo · steps 1 to 3", title="Deploy on a mainnet fork, then steer the agent in plain English",
         panes=[(FULL, DEMO_WIN, ["$ KEEP_FORK=1 npm run demo"] + section(1, 4), 18)],
         vo="The demo forks H S K mainnet and uses Anvil test accounts, so no real funds are involved. The owner deploys the vault, "
            "bound to the live pool. Then I talk to the agent in plain English: position size, risk appetite, how often to check, and what it can trade. "
            "When the agent tries to loosen the stop to seven percent, the contract refuses. It may only tighten."),
    dict(kind="term", kicker="Demo · steps 4 and 5", title="A whale dump: the wick is refused, the confirmed dip is bought",
         panes=[(FULL, DEMO_WIN, section(4, 6), 18)],
         vo="Now a whale sells sixty thousand W H S K into the pool. The agent sees a two percent discount and wants to buy. "
            "The vault says no: the spot price is too far from the average, which looks like manipulation. Ten minutes later the average has caught up, "
            "the discount is still there, and two buys fill. Each reason hash matches the journal on disk."),
    dict(kind="term", kicker="Demo · step 6", title="A compromised agent tries to break the rules",
         panes=[(FULL, DEMO_WIN, section(6, 7), 26)],
         vo="Next, a compromised agent. A five hundred dollar buy, a minimum output of zero, a withdrawal to itself, and a looser stop. "
            "All four revert on-chain."),
    dict(kind="term", kicker="Demo · step 7", title="Crash with the agent offline: a permissionless keeper runs the stop",
         panes=[(FULL, DEMO_WIN, section(7, 8), 18)],
         vo="Then the market crashes and the agent goes offline. The one-block wick does not fire the stop. Once the average crosses the line, "
            "a keeper waits for the anti-sandwich floor to clear, and then sells the position, even though our bot is down."),
    dict(kind="term", kicker="Demo · step 8", title="The final book, and a decision journal that verifies on-chain",
         panes=[(FULL, DEMO_WIN, section(8), 18)],
         vo="The final book is down about four point eight percent after the crash, and both journal entries verify. "
            "No profit is claimed. The stop did its job."),
    dict(kind="image", kicker="Dashboard", title="npm run dashboard — read-only view of the same vault",
         path="docs/dashboard.png", wintitle="localhost:8788 — HSK Sentinel dashboard",
         vo="The read-only dashboard shows the same vault: the two buys with verified reasons, and the keeper's stop-loss exit."),
    dict(kind="card", lines=[("HSK Sentinel", font(INTER, 80, 800), FG, 120),
                             ("github.com/666Crypro/hsk-horizon-agent", font(INTER, 44, 600), BLUE, 90),
                             ("Verify it yourself:  forge test   ·   npm test   ·   npm run demo", T3, FG, 70),
                             ("Built on HSK Chain and HSKSwap  ·  AI Agent Trading track", T4, DIM, 44),
                             ("Unaudited hackathon code. No profit claimed. Demo runs on a local fork with test accounts.", T4, DIM, 44)],
         vo="H S K Sentinel. Our entry in the A I Agent Trading track, built on H S K Chain and H S K Swap. "
            "The code and the commands to verify it are in the repo on screen. Thanks for watching."),
]

# ---------------------------------------------------------------- audio
def tts(i, text):
    p = WORK / f"vo{i:02d}.wav"
    subprocess.run([PIPER, "--model", VOICE, "--output_file", str(p), "--sentence_silence", "0.25"],
                   input=text.encode(), check=True, capture_output=True)
    with wave.open(str(p)) as w:
        return p, w.getnframes() / w.getframerate(), w.getparams()

def main():
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    os.chdir(ROOT)
    clips = [tts(i, s["vo"]) for i, s in enumerate(SCENES)]
    params = clips[0][2]; rate = params.framerate
    pcm = bytearray(); concat = []; t = 0.0; marks = []
    def silence(sec):
        return b"\x00\x00" * int(round(sec * rate)) * params.nchannels
    for i, (s, (p, dur, _)) in enumerate(zip(SCENES, clips)):
        seg = LEAD + dur + TAIL
        with wave.open(str(p)) as w:
            pcm += silence(LEAD) + w.readframes(w.getnframes()) + silence(TAIL)
        marks.append((t, seg, s.get("title") or s["lines"][0][0]))
        # frames
        if s["kind"] == "card":
            frames = [(s["lines"] and card(s["lines"]), seg)]
        elif s["kind"] == "image":
            frames = [(image_frame(s["kicker"], s["title"], s["path"], s["wintitle"]), seg)]
        else:
            n = count_vis(s["panes"])
            reveal = min(dur * 0.7, max(2.0, n * 0.12))
            steps = min(n, 30)
            per = reveal / steps
            frames = []
            for k in range(1, steps + 1):
                shown = round(n * k / steps)
                frames.append((term_frame(s["kicker"], s["title"], s["panes"], shown), per if k < steps else seg - reveal + per))
        for j, (img, d) in enumerate(frames):
            fp = WORK / f"s{i:02d}_{j:03d}.png"
            img.save(fp)
            concat.append((fp, d))
        t += seg
    with wave.open(str(WORK / "narration.wav"), "wb") as w:
        w.setparams(params); w.writeframes(bytes(pcm))
    with open(WORK / "frames.txt", "w") as f:
        for fp, d in concat:
            f.write(f"file '{fp}'\nduration {d:.4f}\n")
        f.write(f"file '{concat[-1][0]}'\n")
    for st, seg, name in marks:
        print(f"{st:7.2f}s  +{seg:5.2f}s  {name}")
    (WORK / "marks.txt").write_text("\n".join(f"{st:.3f}\t{seg:.3f}\t{name}" for st, seg, name in marks))
    subprocess.check_call(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(WORK / "frames.txt"),
                           "-i", str(WORK / "narration.wav"), "-vf", "fps=30,format=yuv420p",
                           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-tune", "stillimage",
                           "-af", "loudnorm=I=-16:LRA=11:TP=-1.5", "-ar", "48000", "-c:a", "aac", "-b:a", "160k",
                           "-movflags", "+faststart", "-t", f"{t:.3f}", str(OUT)])
    print(f"wrote {OUT} {t:.2f}s {OUT.stat().st_size/1e6:.2f} MB")

if __name__ == "__main__":
    main()
