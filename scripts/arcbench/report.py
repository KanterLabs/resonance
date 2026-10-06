"""Render the energy-source comparison as one HTML page of inline SVG charts."""
import json, html
import numpy as np

D = "/tmp/arcbench"
S = json.load(open(f"{D}/scores.json"))
M = json.load(open(f"{D}/measured.json"))
L = json.load(open(f"{D}/library.json"))
esc = html.escape


def bar_chart(rows, title, sub, max_value=1.0, fmt=lambda v: f"{v:.2f}", width=640):
    """Horizontal bars, one series. rows: (label, value or None, note)."""
    row_h, label_w, pad_r = 34, 210, 170
    plot_w = width - label_w - pad_r
    h = row_h * len(rows) + 30
    out = [f'<svg viewBox="0 0 {width} {h}" width="{width}" height="{h}" role="img" aria-label="{esc(title)}">']
    for t in (0, 0.25, 0.5, 0.75, 1.0):
        x = label_w + plot_w * t
        out.append(f'<line x1="{x}" x2="{x}" y1="4" y2="{h-24}" class="grid"/>'
                   f'<text x="{x}" y="{h-8}" class="axis" text-anchor="middle">{fmt(t*max_value)}</text>')
    for i, (label, value, note) in enumerate(rows):
        y = 8 + i * row_h
        out.append(f'<text x="{label_w-10}" y="{y+16}" class="label" text-anchor="end">{esc(label)}</text>')
        if value is None:
            out.append(f'<text x="{label_w+6}" y="{y+16}" class="muted">{esc(note)}</text>')
            continue
        w = max(plot_w * value / max_value, 2)
        tip = esc(f"{label}: {fmt(value)} ({note})")
        out.append(f'<g class="hit" data-tip="{tip}"><rect x="{label_w}" y="{y}" width="{plot_w+pad_r}" height="{row_h-6}" fill="transparent"/>'
                   f'<path d="M{label_w},{y+3} h{w-4} a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h-{w-4} z" class="bar"/></g>'
                   f'<text x="{label_w+w+8}" y="{y+16}" class="value">{fmt(value)}</text>'
                   f'<text x="{label_w+w+48}" y="{y+16}" class="muted">{esc(note)}</text>')
    out.append("</svg>")
    return f'<figure><figcaption><b>{esc(title)}</b><span>{esc(sub)}</span></figcaption>{"".join(out)}</figure>'


def scatter(points, title, sub, xlabel, size=300):
    """points: (x, y, name). y is full-listen energy. Axes fitted to the data."""
    pad = 44
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    def rng(v):
        lo, hi = min(v), max(v); m = (hi - lo) * 0.08 or 0.05
        return lo - m, hi + m
    (x0, x1), (y0, y1) = rng(xs), rng(ys)
    sx = lambda v: pad + (v - x0) / (x1 - x0) * (size - pad - 10)
    sy = lambda v: size - pad - (v - y0) / (y1 - y0) * (size - pad - 10)
    out = [f'<svg viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="{esc(title)}">',
           f'<line x1="{pad}" x2="{size-10}" y1="{size-pad}" y2="{size-pad}" class="axisline"/>',
           f'<line x1="{pad}" x2="{pad}" y1="10" y2="{size-pad}" class="axisline"/>',
           f'<text x="{(size+pad)/2}" y="{size-12}" class="axis" text-anchor="middle">{esc(xlabel)}</text>',
           f'<text transform="translate(12,{(size-pad)/2}) rotate(-90)" class="axis" text-anchor="middle">full-listen energy</text>']
    for t in np.linspace(x0, x1, 4)[1:-1]:
        out.append(f'<text x="{sx(t)}" y="{size-pad+14}" class="axis" text-anchor="middle">{t:.2f}</text>')
    for t in np.linspace(y0, y1, 4)[1:-1]:
        out.append(f'<text x="{pad-4}" y="{sy(t)+4}" class="axis" text-anchor="end">{t:.2f}</text>')
    for x, y, name in points:
        tip = esc(f"{name}: {x:.2f} vs full listen {y:.2f}")
        out.append(f'<g class="hit" data-tip="{tip}"><circle cx="{sx(x)}" cy="{sy(y)}" r="12" fill="transparent"/>'
                   f'<circle cx="{sx(x)}" cy="{sy(y)}" r="4.5" class="dot"/></g>')
    out.append("</svg>")
    return f'<figure><figcaption><b>{esc(title)}</b><span>{esc(sub)}</span></figcaption>{"".join(out)}</figure>'


# ---- chart 1: agreement with full listens ----
n = len(M)
def row(name, label):
    s = S[name]
    rho = s["rho"]
    if rho is None or s["n"] < 5:
        return (label, None, f"only {s['n']} of {n} songs have it")
    return (label, abs(rho), f"{s['n']}/{n} songs")
agree = [row("Deezer preview (tap)", "Deezer preview, our analysis"),
         row("Deezer gain", "Deezer gain (no download)"),
         row("Same-artist estimate (today)", "Same-artist estimate (today)"),
         row("ReccoBeats energy", "ReccoBeats energy"),
         row("Heard loudness (today)", "Heard loudness (today)")]

# ---- chart 2: scatters ----
pv = [(p[0], p[1], p[2]) for p in S["Deezer preview (tap)"]["points"]]
rb = [(p[0], p[1], p[2]) for p in S["ReccoBeats energy"]["points"]]

# ---- chart 3: coverage over library sample ----
N = len(L)
dz = [r for r in L if r["deezer"]]
cov = [("Deezer match", len(dz) / N, f"{len(dz)}/{N}"),
       ("Deezer preview analysed", sum(bool(r["deezer"]["preview"]) for r in dz) / N, f"{sum(bool(r['deezer']['preview']) for r in dz)}/{N}"),
       ("ReccoBeats features", sum(bool(r["recco"]) for r in L) / N, f"{sum(bool(r['recco']) for r in L)}/{N}"),
       ("Tempo from preview", sum(bool(r["deezer"]["preview"] and r["deezer"]["preview"]["tempo"]) for r in dz) / N,
        f"{sum(bool(r['deezer']['preview'] and r['deezer']['preview']['tempo']) for r in dz)}/{N}"),
       ("Deezer BPM (non-zero)", sum(bool(r["deezer"]["bpm"]) for r in dz) / N, f"{sum(bool(r['deezer']['bpm']) for r in dz)}/{N}")]
pct = lambda v: f"{v*100:.0f}%"

# ---- chart 4: tempo agreement with ReccoBeats ----
def fold(t):
    while t < 70: t *= 2
    while t >= 140: t /= 2
    return t
def agree_rate(get):
    pairs = [(get(r), fold(r["recco"]["tempo"])) for r in dz if r["recco"] and get(r)]
    hit = sum(abs(a - b) / b < 0.04 for a, b in pairs)
    return hit / len(pairs), f"{hit}/{len(pairs)} agree"
tempo = [("Deezer BPM", *agree_rate(lambda r: fold(r["deezer"]["bpm"]) if r["deezer"]["bpm"] else None)),
         ("Our tap on the preview", *agree_rate(lambda r: r["deezer"]["preview"]["tempo"] if r["deezer"]["preview"] else None))]

page = f"""<!doctype html><html><head><meta charset="utf-8"><title>Arc energy sources</title>
<style>
.viz-root {{ color-scheme: light; --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#7a7974; --grid:#e6e5e0; --series-1:#2a78d6; }}
@media (prefers-color-scheme: dark) {{ :root:where(:not([data-theme="light"])) .viz-root {{ color-scheme: dark; --surface-1:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#8f8e86; --grid:#2e2e2c; --series-1:#3987e5; }} }}
:root[data-theme="dark"] .viz-root {{ color-scheme: dark; --surface-1:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#8f8e86; --grid:#2e2e2c; --series-1:#3987e5; }}
body {{ margin:0; }}
.viz-root {{ background:var(--surface-1); color:var(--text-primary); font:14px/1.45 system-ui,sans-serif; padding:28px 36px; min-height:100vh; box-sizing:border-box; }}
h1 {{ font-size:20px; margin:0 0 4px; }} .lede {{ color:var(--text-secondary); margin:0 0 22px; max-width:760px; }}
.grid2 {{ display:flex; flex-wrap:wrap; gap:28px 40px; }}
figure {{ margin:0 0 26px; }} figcaption {{ display:flex; flex-direction:column; margin-bottom:8px; }}
figcaption span {{ color:var(--text-secondary); font-size:13px; }}
.grid {{ stroke:var(--grid); stroke-width:1; }} .axisline {{ stroke:var(--text-muted); stroke-width:1; }}
.axis {{ fill:var(--text-muted); font-size:11px; }} .label {{ fill:var(--text-primary); font-size:13px; }}
.value {{ fill:var(--text-primary); font-size:13px; font-weight:600; }} .muted {{ fill:var(--text-muted); font-size:12px; }}
.bar {{ fill:var(--series-1); }} .dot {{ fill:var(--series-1); stroke:var(--surface-1); stroke-width:2; }}
.hit:hover .bar, .hit:hover .dot {{ opacity:.8; }}
#tip {{ position:fixed; pointer-events:none; background:var(--text-primary); color:var(--surface-1); padding:4px 8px; border-radius:4px; font-size:12px; display:none; }}
</style></head><body><div class="viz-root">
<h1>Which source gets arc energy right without a listen?</h1>
<p class="lede">Graded against the {n} songs your laptop has fingerprinted by listening, plus a random {N} songs from your library for coverage.
Arcs rank energy against the library before using it, so agreement is measured as rank correlation (Spearman ρ): 1 means the source orders songs exactly as a full listen does.</p>
{bar_chart(agree, "Agreement with full-listen energy", f"Spearman ρ against your {n} fingerprints; higher is better. Deezer gain runs the opposite direction, so its size is shown.")}
<div class="grid2">
{scatter(pv, "Deezer preview vs full listen", f"ρ = {S['Deezer preview (tap)']['rho']:.2f}, {len(pv)} songs", "preview energy (our tap analysis)")}
{scatter(rb, "ReccoBeats vs full listen", f"ρ = {S['ReccoBeats energy']['rho']:.2f}, {len(rb)} songs", "ReccoBeats energy")}
</div>
<div class="grid2">
{bar_chart(cov, "Coverage", f"Share of {N} random library songs each source can describe", fmt=pct, width=560)}
{bar_chart(tempo, "Tempo reliability", "Agreement with ReccoBeats tempo (folded to 70–140 BPM)", fmt=pct, width=560)}
</div>
</div><div id="tip"></div>
<script>
const tip=document.getElementById('tip');
document.querySelectorAll('.hit').forEach(g=>{{g.addEventListener('mousemove',e=>{{tip.textContent=g.dataset.tip;tip.style.display='block';tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';}});g.addEventListener('mouseleave',()=>tip.style.display='none');}});
</script></body></html>"""
open(f"{D}/report.html", "w").write(page)
print("wrote report.html")
