# /// script
# requires-python = ">=3.10"
# ///
"""
KML/KMZ files + per-mission flight text  ->  one <DATE>.mission.json the web app loads.

Pure computation, no network — the nightly agent runs this after scraping the portal,
then drops the result in scripts/pending/ for drive_writer.py to upload.

Input manifest (JSON, stdin or a path):
    {"date": "2026-08-07",
     "records": [{"title": "סכנין", "kml": "<?xml ...", "flight": "מצב: 2D / גובה: 70מ'..."},
                 {"title": "...",  "kmlFile": "/path/to/x.kml", "flight": ""}]}
`kml` (inline text) or `kmlFile` (path, .kml or real zipped .kmz) — one of the two.
Records must be in the order they appear on the portal; `flight` may be "".

Output: the mission JSON on stdout, or to --out PATH.

The zone shape mirrors app.js:651 exactly — {order, name, feature, flight} — and the
naming/de-dup rules mirror addZonesFromGeoJSON (app.js:421) so a mission built here is
indistinguishable from one built by dragging the same files into the app:
  * placemark <name> wins, unless it's generic ("Polygon 1"/"Untitled"/empty), in which
    case a Hebrew ExtendedData value, then a label-ish one, then the file title;
  * identical rings are dropped (files often repeat a polygon);
  * a name used by several polygons gets numbered "סכנין 1", "סכנין 2";
  * zones are ordered greedy nearest-neighbor by centroid.
Names matter beyond cosmetics: the app pairs each zone's flight settings by NAME on
load (app.js:788), so a name that doesn't survive the round trip loses its settings.
"""
import io
import json
import math
import pathlib
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

GENERIC = re.compile(r"^(polygon\s*\d+|untitled.*)$", re.I)
HEBREW = re.compile(r"[֐-׿]")
BIDI = re.compile(r"[‎‏⁦-⁩]")


def decode_xml(data: bytes) -> str:
    """Honor the file's real encoding so Hebrew names survive (mirrors geo.js decodeXml)."""
    if data[:2] == b"\xff\xfe":
        return data.decode("utf-16le")
    if data[:2] == b"\xfe\xff":
        return data.decode("utf-16be")
    head = data[:200].decode("ascii", "ignore")
    m = re.search(r'encoding=["\']([\w-]+)["\']', head, re.I)
    try:
        return data.decode(m.group(1) if m else "utf-8")
    except (LookupError, UnicodeDecodeError):
        return data.decode("utf-8", "replace")


def kml_text(raw: bytes) -> str:
    """A zip starts with 'PK' — detect KMZ by content, not extension (app.js:406)."""
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            entry = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
            if not entry:
                raise ValueError("no .kml inside the KMZ")
            raw = z.read(entry)
    return decode_xml(raw)


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _text(el):
    return (el.text or "").strip() if el is not None else ""


def parse_placemarks(xml: str):
    """[(properties dict, [outer ring, ...]), ...] for every Placemark holding polygons."""
    root = ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
    out = []
    for pm in root.iter():
        if _local(pm.tag) != "Placemark":
            continue
        props = {}
        for child in pm:
            if _local(child.tag) == "name":
                props["name"] = _text(child)
        # togeojson flattens ExtendedData Data/SimpleData into properties — featureName
        # falls back to these when the placemark name is generic.
        for d in pm.iter():
            t = _local(d.tag)
            if t == "Data":
                k = d.get("name")
                v = next((_text(c) for c in d if _local(c.tag) == "value"), "")
                if k and v:
                    props.setdefault(k, v)
            elif t == "SimpleData":
                k, v = d.get("name"), _text(d)
                if k and v:
                    props.setdefault(k, v)
        rings = []
        for poly in pm.iter():
            if _local(poly.tag) != "Polygon":
                continue
            for ob in poly:
                if _local(ob.tag) != "outerBoundaryIs":
                    continue
                for lr in ob:
                    if _local(lr.tag) != "LinearRing":
                        continue
                    coords = next((_text(c) for c in lr if _local(c.tag) == "coordinates"), "")
                    ring = []
                    for tok in coords.split():
                        parts = tok.split(",")
                        if len(parts) >= 2:
                            ring.append([float(parts[0]), float(parts[1])])  # KML is lng,lat
                    if len(ring) >= 3:
                        if ring[0] != ring[-1]:
                            ring.append(list(ring[0]))  # close the ring
                        rings.append(ring)
        if rings:
            out.append((props, rings))
    return out


def feature_name(props, fallback):
    """Mirrors geo.js featureName."""
    name = str(props.get("name", "")).strip()
    if name and not GENERIC.match(name):
        return name
    strs = [(k, v) for k, v in props.items() if k != "name" and isinstance(v, str) and v.strip()]
    heb = next((v for _, v in strs if HEBREW.search(v)), None)
    if heb:
        return heb.strip()
    labelish = next((v for k, v in strs if re.search(r"name|title|label", k, re.I)), None)
    return labelish.strip() if labelish else fallback


def centroid(ring):
    """Vertex-average, dropping the closing duplicate (mirrors geo.js centroid)."""
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    return [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)]


def haversine(a, b):
    R = 6371.0
    dlat, dlng = math.radians(b["lat"] - a["lat"]), math.radians(b["lng"] - a["lng"])
    s = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(a["lat"])) * math.cos(math.radians(b["lat"])) * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(s))


def order_nearest(points):
    """Greedy nearest-neighbor from the first point (mirrors geo.js orderByNearestNeighbor)."""
    if not points:
        return []
    remaining, order = points[1:], [points[0]]
    while remaining:
        cur = order[-1]
        i = min(range(len(remaining)), key=lambda j: haversine(cur, remaining[j]))
        order.append(remaining.pop(i))
    return order


def build(manifest):
    date = manifest["date"]
    items = []          # {base, ring, flight}
    seen_sig = set()
    skipped_dupes = 0
    for rec in manifest["records"]:
        if "kml" in rec and rec["kml"]:
            xml = rec["kml"]
        else:
            xml = kml_text(pathlib.Path(rec["kmlFile"]).read_bytes())
        label = BIDI.sub("", re.sub(r"\.(kml|kmz)$", "", rec.get("title", ""), flags=re.I)).strip()
        placemarks = parse_placemarks(xml)
        if not placemarks:
            raise ValueError(f"{rec.get('title')!r}: no polygons in this KML")
        for props, rings in placemarks:
            base = feature_name(props, label or f"Zone {len(items) + 1}")
            for ring in rings:
                sig = " ".join(f"{x},{y}" for x, y in ring)
                if sig in seen_sig:
                    skipped_dupes += 1
                    continue
                seen_sig.add(sig)
                items.append({"base": base, "ring": ring, "flight": rec.get("flight", "") or ""})

    total = {}
    for it in items:
        total[it["base"]] = total.get(it["base"], 0) + 1
    seen = {}
    zones = []
    for it in items:
        seen[it["base"]] = seen.get(it["base"], 0) + 1
        name = f"{it['base']} {seen[it['base']]}" if total[it["base"]] > 1 else it["base"]
        clng, clat = centroid(it["ring"])
        zones.append({"name": name, "lat": clat, "lng": clng,
                      "ring": it["ring"], "flight": it["flight"]})

    ordered = order_nearest(zones)
    name = f"{date}.mission.json"
    doc = {"name": name,
           "zones": [{"order": i + 1, "name": z["name"],
                      "feature": {"type": "Feature", "properties": {"name": z["name"]},
                                  "geometry": {"type": "Polygon", "coordinates": [z["ring"]]}},
                      "flight": z["flight"]}
                     for i, z in enumerate(ordered)]}
    return doc, {"zones": len(zones), "withFlight": sum(1 for z in zones if z["flight"].strip()),
                 "duplicateRingsSkipped": skipped_dupes}


def selftest():
    def kml(name, ring, extended=""):
        c = " ".join(f"{x},{y},0" for x, y in ring)
        return ('<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2">'
                f"<Document><Placemark><name>{name}</name>{extended}"
                f"<Polygon><outerBoundaryIs><LinearRing><coordinates>{c}</coordinates>"
                "</LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>")

    a = [[35.20, 32.70], [35.21, 32.70], [35.21, 32.71], [35.20, 32.70]]
    b = [[35.60, 32.90], [35.61, 32.90], [35.61, 32.91], [35.60, 32.90]]
    c = [[35.25, 32.72], [35.26, 32.72], [35.26, 32.73], [35.25, 32.72]]

    doc, stats = build({"date": "2026-08-07", "records": [
        {"title": "סכנין", "kml": kml("Polygon 1", a), "flight": "גובה: 70"},
        {"title": "עראבה", "kml": kml("עראבה מזרח", b), "flight": ""},
        {"title": "קרוב", "kml": kml("Polygon 1", c), "flight": "גובה: 90"},
        {"title": "כפול", "kml": kml("Polygon 1", a), "flight": "לא רלוונטי"},
    ]})
    names = [z["name"] for z in doc["zones"]]
    assert stats["zones"] == 3 and stats["duplicateRingsSkipped"] == 1, stats
    assert doc["name"] == "2026-08-07.mission.json"
    # generic placemark name -> file title; real placemark name kept verbatim
    assert set(names) == {"סכנין", "עראבה מזרח", "קרוב"}, names
    # nearest-neighbor: from סכנין the near zone comes before the far one
    assert names.index("קרוב") < names.index("עראבה מזרח"), names
    flights = {z["name"]: z["flight"] for z in doc["zones"]}
    assert flights["סכנין"] == "גובה: 70" and flights["קרוב"] == "גובה: 90" and flights["עראבה מזרח"] == ""
    # feature.properties.name must equal zone.name or the app renames on load and the
    # flight pairing (app.js:788) breaks
    assert all(z["feature"]["properties"]["name"] == z["name"] for z in doc["zones"])
    assert all(z["order"] == i + 1 for i, z in enumerate(doc["zones"]))
    # coords stay lng,lat and rings stay closed
    for z in doc["zones"]:
        ring = z["feature"]["geometry"]["coordinates"][0]
        assert ring[0] == ring[-1], "ring must be closed"
        assert 34 < ring[0][0] < 36 and 31 < ring[0][1] < 34, "lng,lat order broken"

    # duplicate base names get numbered
    doc2, _ = build({"date": "2026-08-07", "records": [
        {"title": "סכנין", "kml": kml("Polygon 1", a), "flight": "x"},
        {"title": "סכנין", "kml": kml("Polygon 2", b), "flight": "x"}]})
    assert {z["name"] for z in doc2["zones"]} == {"סכנין 1", "סכנין 2"}, doc2

    # ExtendedData fallback when the placemark name is generic and there's no useful title
    doc3, _ = build({"date": "2026-08-07", "records": [
        {"title": "", "kml": kml("Untitled Polygon", a,
                                 '<ExtendedData><Data name="site"><value>דיר חנא</value></Data></ExtendedData>'),
         "flight": ""}]})
    assert doc3["zones"][0]["name"] == "דיר חנא", doc3

    # a real zipped KMZ round-trips
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("doc.kml", kml("מג'ד אל-כרום", b))
    p = pathlib.Path("/tmp/_k2m_test.kmz")
    p.write_bytes(buf.getvalue())
    doc4, _ = build({"date": "2026-08-07", "records": [{"title": "t", "kmlFile": str(p), "flight": ""}]})
    assert doc4["zones"][0]["name"] == "מג'ד אל-כרום", doc4
    p.unlink()
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = None
    if "--out" in sys.argv:
        out = pathlib.Path(sys.argv[sys.argv.index("--out") + 1])
        args = [a for a in args if a != str(out)]
    src = pathlib.Path(args[0]).read_text() if args else sys.stdin.read()
    doc, stats = build(json.loads(src))
    text = json.dumps(doc, ensure_ascii=False)
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text)
        print(json.dumps({"wrote": str(out), **stats}, ensure_ascii=False))
    else:
        print(text)
