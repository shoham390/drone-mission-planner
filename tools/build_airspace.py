#!/usr/bin/env python3
"""Rebuild airspace.geojson from the official Israel eAIP (+ OpenAIP CTR + border).

Update after Israel publishes a new AIRAC cycle:
  1. Find the current effective date at https://e-aip.azurefd.net/ (e.g. 2026-08-06).
  2. python3 tools/build_airspace.py 2026-08-06
  3. Eyeball the printed self-check (counts, "issues" should be empty), then commit.

Pure stdlib — no pip installs. Sources:
  LLP/LLR : eAIP ENR 5.1 (exact DMS coords; circle/arc definitions computed).  <- authoritative
  CTR     : OpenAIP daily export (community; CTRs aren't in ENR sections).
  border  : world-geojson state boundary (reference line only).
Danger areas (LLD) are intentionally absent: Israel's civil AIP lists none.
"""
import re, math, json, sys, os, urllib.request

AIRAC = sys.argv[1] if len(sys.argv) > 1 else "2025-10-02"
OUT = os.path.join(os.path.dirname(__file__), "..", "airspace.geojson")
ENR51 = f"https://e-aip.azurefd.net/{AIRAC}-AIRAC/html/eAIP/LL-ENR-5.1-en-GB.html"
OPENAIP = "https://storage.googleapis.com/29f98e10-a489-4c82-ae5e-489dbcd4912f/il_asp.geojson"
BORDER = "https://raw.githubusercontent.com/georgique/world-geojson/develop/countries/israel.json"

def get(url):
    with urllib.request.urlopen(url, timeout=60) as r: return r.read().decode("utf-8", "replace")

# ---- eAIP ENR 5.1 parser (DMS points + circle/arc clauses) ----
def plaintext(h):
    t = re.sub(r"(?s)<(script|style).*?</\1>", "", h); t = re.sub(r"<[^>]+>", " ", t)
    for a, b in [("&#160;", " "), ("&nbsp;", " ")]: t = t.replace(a, b)
    return re.sub(r"[ \t\n]+", " ", t)
def dlat(t): m = re.fullmatch(r"(\d{2})(\d{2})(\d{2})N", t); return int(m[1]) + int(m[2]) / 60 + int(m[3]) / 3600
def dlng(t): m = re.fullmatch(r"(\d{3})(\d{2})(\d{2})E", t); return int(m[1]) + int(m[2]) / 60 + int(m[3]) / 3600
def km(v, u): return float(v) * (1.852 if u == "NM" else 1.0)
def dest(lat, lng, brg, d):
    a = math.radians(brg); dl = d / 111.19458
    return [lng + dl * math.sin(a) / math.cos(math.radians(lat)), lat + dl * math.cos(a)]
def bearing(clat, clng, plat, plng):
    return math.degrees(math.atan2((plng - clng) * math.cos(math.radians(clat)), plat - clat)) % 360
def circle(clat, clng, r, n=72): return [dest(clat, clng, b * 360 / n, r) for b in range(n + 1)]
def arc(clat, clng, r, a0, a1, cw, n=32):
    a0 %= 360; a1 %= 360; sweep = ((a0 - a1) if cw else (a1 - a0)) % 360
    return [dest(clat, clng, (a0 - sweep * i / n) if cw else (a0 + sweep * i / n), r) for i in range(n + 1)]
CIRC = re.compile(r"circle radius ([\d.]+) (KM|NM) centered on (\d{6}N) (\d{7}E)")
def parse_boundary(bnd):
    if "then" not in bnd:
        m = CIRC.search(bnd)
        if m: return circle(dlat(m[3]), dlng(m[4]), km(m[1], m[2]))
    toks = bnd.split(); pts = []; i = 0
    while i < len(toks):
        t = toks[i]
        if re.fullmatch(r"\d{6}N", t) and i + 1 < len(toks) and re.fullmatch(r"\d{7}E", toks[i + 1]):
            pts.append([dlng(toks[i + 1]), dlat(t)]); i += 2; continue
        if t == "then":
            m = re.match(r"then a (clockwise|anti-?clockwise|counter-?clockwise) arc radius ([\d.]+) (KM|NM) centered on",
                         " ".join(toks[i:i + 11]))
            if m:
                j = i
                while toks[j] != "on": j += 1
                clat = dlat(toks[j + 1]); clng = dlng(toks[j + 2]); r = km(m[2], m[3]); cw = (m[1] == "clockwise")
                kk = j + 3
                while kk < len(toks) and toks[kk] == "-": kk += 1
                A = pts[-1]; B = [dlng(toks[kk + 1]), dlat(toks[kk])]
                a0 = bearing(clat, clng, A[1], A[0]); a1 = bearing(clat, clng, B[1], B[0])
                pts.extend(arc(clat, clng, r, a0, a1, cw)[1:]); i = kk; continue
        i += 1
    if pts and pts[0] != pts[-1]: pts.append(pts[0])
    return pts
def parse_section(txt, prefix):
    ids = [(m.start(), m.group()) for m in re.finditer(rf"\b{prefix}\d+\b", txt)]
    out = {}
    for k, (pos, idn) in enumerate(ids):
        end = ids[k + 1][0] if k + 1 < len(ids) else len(txt)
        chunk = txt[pos + len(idn):end]
        lm = re.search(r"(FL\s*\d+|\d+\s*FT(?:\s*ALT)?)", chunk)   # first alt token = end of boundary
        bnd = chunk[:lm.start()] if lm else chunk
        lims = re.findall(r"(?:FL\s*\d+|\d+\s*FT(?:\s*ALT)?)", chunk[lm.start():lm.start() + 40]) if lm else []
        band = f"{lims[0]} / {lims[1]}" if len(lims) >= 2 else (lims[0] + " / GND" if lims else "?")
        try: poly = parse_boundary(bnd.strip())
        except Exception as e: print("PARSE ERR", idn, e); poly = None
        if poly and len(poly) >= 4: out[idn] = {"poly": poly, "band": band}
    return out

def band_fmt(b):
    if "/" not in b: return b
    norm = lambda x: "GND" if re.fullmatch(r"0\s*FT(?:\s*ALT)?", x.strip()) else x.strip()
    up, lo = [norm(s) for s in b.split("/", 1)]; return f"{lo} – {up}"

# ---- build ----
print(f"AIRAC {AIRAC}: fetching eAIP ENR 5.1 …")
txt = plaintext(get(ENR51))
LLP = parse_section(txt, "LLP"); LLR = parse_section(txt, "LLR")
feats = []
for cat, src in (("P", LLP), ("R", LLR)):
    for idn, a in src.items():
        feats.append({"type": "Feature", "properties": {"cat": cat, "name": idn, "band": band_fmt(a["band"])},
                      "geometry": {"type": "Polygon", "coordinates": [a["poly"]]}})
print("fetching OpenAIP (CTR) …")
UNIT = {1: "ft", 6: "FL"}; DAT = {0: "AGL", 1: "AMSL", 2: "STD"}
def lim(l):
    v = l["value"]; u = l.get("unit", 1); d = l.get("referenceDatum", 1)
    return "GND" if (v == 0 and d == 0) else f"{v}{UNIT.get(u, 'ft')} {DAT.get(d, '')}".strip()
for f in json.loads(get(OPENAIP))["features"]:
    p = f["properties"]
    if p["type"] == 4:  # CTR
        feats.append({"type": "Feature", "properties": {"cat": "CTR", "name": p["name"],
                      "band": f'{lim(p["lowerLimit"])} – {lim(p["upperLimit"])}'}, "geometry": f["geometry"]})
print("fetching border reference …")
def rings(g):
    if g["type"] == "Polygon": return [g["coordinates"][0]]
    if g["type"] == "MultiPolygon": return [poly[0] for poly in g["coordinates"]]
    return []
for f in json.loads(get(BORDER))["features"]:
    for r in rings(f["geometry"]):
        feats.append({"type": "Feature", "properties": {"cat": "border", "name": "State border (reference)",
                      "band": "Near-border flight prohibited — buffer is NOTAM-dependent, not fixed"},
                      "geometry": {"type": "LineString", "coordinates": r}})

gj = {"type": "FeatureCollection",
      "properties": {"source": f"eAIP LL ENR 5.1 AIRAC {AIRAC} (LLP/LLR exact, arcs computed) + OpenAIP (CTR) + world-geojson (border ref)",
                     "note": "Planning aid, NOT for clearance. No danger areas (LLD): Israel civil AIP lists none."},
      "features": feats}
json.dump(gj, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))

# ---- self-check ----
import collections
c = collections.Counter(f["properties"]["cat"] for f in feats)
issues = [f["properties"]["name"] for f in feats if f["geometry"]["type"] == "Polygon"
          and (f["geometry"]["coordinates"][0][0] != f["geometry"]["coordinates"][0][-1]
               or any(not (33.9 < x < 36.7 and 29 < y < 34) for x, y in f["geometry"]["coordinates"][0]))]
print(f"\nwrote {os.path.relpath(OUT)}: {dict(c)}  total {len(feats)}")
print("open/out-of-bounds polygons (expect only LLR01/LLR02, which extend over the sea):", issues)
