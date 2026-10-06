import json, numpy as np
from collections import defaultdict
D="/tmp/arcbench"
m=json.load(open(f"{D}/measured.json"))
wf={e["id"]:e["levels"] for e in json.load(open(f"{D}/waveforms.db"))["entries"]}
def heard(r):
    lv=[x for x in wf.get(r["id"],[]) if x>0.01]
    return float(np.clip((np.mean(lv)-0.4)/0.55,0,1)) if len(lv)>=8 else None
by_artist=defaultdict(list)
for r in m: by_artist[r["artist"].lower()].append(r)
def loo(r):
    o=[x["fp"]["energy"] for x in by_artist[r["artist"].lower()] if x is not r]
    return float(np.mean(o)) if o else None
def rank(a): return np.argsort(np.argsort(a)).astype(float)
def spear(x,y): return float(np.corrcoef(rank(x),rank(y))[0,1])
src={
 "Deezer preview (tap)": lambda r: r["deezer"]["preview"]["energy"] if r["deezer"] and r["deezer"]["preview"] else None,
 "ReccoBeats energy": lambda r: r["recco"]["energy"] if r["recco"] else None,
 "Deezer gain": lambda r: -r["deezer"]["gain"] if r["deezer"] and r["deezer"]["gain"] is not None else None,
 "Heard loudness (today)": heard,
 "Same-artist estimate (today)": loo,
}
out={}
for name,f in src.items():
    pairs=[(f(r),r["fp"]["energy"],r["title"]) for r in m if f(r) is not None]
    x=np.array([p[0] for p in pairs]); y=np.array([p[1] for p in pairs])
    rho=spear(x,y) if len(pairs)>3 else None
    # rank-based error: percentile-vs-percentile mean abs diff
    out[name]={"n":len(pairs),"of":len(m),"rho":rho,"points":pairs}
    print(f"{name:30} n={len(pairs):2}/{len(m)}  spearman={rho if rho is None else round(rho,2)}")
# tempo
for name,f in {"Deezer bpm":lambda r:r["deezer"]["bpm"] if r["deezer"] else None,
               "Preview tap tempo":lambda r:r["deezer"]["preview"]["tempo"] if r["deezer"] and r["deezer"]["preview"] else None,
               "ReccoBeats tempo":lambda r:r["recco"]["tempo"] if r["recco"] else None}.items():
    pr=[(f(r),r["fp"]["tempo"],r["title"]) for r in m if f(r) and r["fp"]["tempo"]]
    print(name, [(round(a),round(b),t[:18]) for a,b,t in pr])
print("match kinds", [r["deezer"]["match"] if r["deezer"] else None for r in m])
json.dump(out,open(f"{D}/scores.json","w"))
