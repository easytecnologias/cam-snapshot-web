from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

from app.services.camsnapshot.kmz_enricher import enrich_single_kmz

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}
_AUTO_NS_URI = "http://www.w3.org/2005/Atom"


def sanitize_kml_xml(data: bytes | str) -> bytes:
    """Make Google Earth KML variants parseable by ElementTree.

    Some KMZ files exported by Google Earth include ns2/ns3-prefixed Atom tags
    without declaring those prefixes. Google Earth accepts them, but Python's
    XML parser rejects the whole file with "unbound prefix".
    """
    text = data.decode("utf-8", errors="replace") if isinstance(data, (bytes, bytearray)) else str(data or "")
    used_prefixes = set(re.findall(r"</?(ns\d+):[A-Za-z_][\w.-]*", text))
    if not used_prefixes:
        return text.encode("utf-8")

    m = re.search(r"<kml\b([^>]*)>", text, flags=re.IGNORECASE)
    if not m:
        return text.encode("utf-8")

    attrs = m.group(1) or ""
    missing = [p for p in sorted(used_prefixes) if f"xmlns:{p}=" not in attrs]
    if not missing:
        return text.encode("utf-8")

    additions = "".join(f' xmlns:{p}="{_AUTO_NS_URI}"' for p in missing)
    start, end = m.span()
    fixed = text[:end - 1] + additions + text[end - 1:]
    return fixed.encode("utf-8")


def _norm_text(v: Any) -> str:
    s = str(v or "").strip().lower()
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


_STOPWORDS = {
    "a", "o", "as", "os", "de", "da", "do", "das", "dos",
    "e", "em", "na", "no", "nas", "nos", "pra", "para",
}


def _singularize_token(tok: str) -> str:
    t = str(tok or "").strip()
    if len(t) <= 3:
        return t
    if t.endswith("oes"):
        return t[:-3] + "ao"
    if t.endswith("aes"):
        return t[:-3] + "ao"
    if t.endswith("is") and len(t) > 4:
        return t[:-2] + "l"
    if t.endswith("es") and len(t) > 4:
        return t[:-2]
    if t.endswith("s") and len(t) > 4:
        return t[:-1]
    return t


def _extract_leading_num(s: str) -> str:
    m = re.match(r"^\s*(\d{1,4})\b", str(s or ""))
    if not m:
        return ""
    try:
        return str(int(m.group(1)))
    except Exception:
        return m.group(1).lstrip("0") or "0"


def _name_variants(v: Any) -> set[str]:
    base = _norm_text(v)
    if not base:
        return set()
    toks = [t for t in base.split() if t]
    out: set[str] = {base}
    if toks:
        out.add(" ".join(toks))
        no_sw = [t for t in toks if t not in _STOPWORDS]
        if no_sw:
            out.add(" ".join(no_sw))
        sing = [_singularize_token(t) for t in toks]
        out.add(" ".join(sing))
        sing_no_sw = [t for t in sing if t not in _STOPWORDS]
        if sing_no_sw:
            out.add(" ".join(sing_no_sw))
    return {x.strip() for x in out if x and x.strip()}


def _best_fuzzy_hit(
    key: str,
    idx: dict[str, list[tuple[float, float]]],
    num_hint: str = "",
    min_ratio: float = 0.88,
) -> tuple[float, float] | None:
    if not key or not idx:
        return None
    best_k = ""
    best_ratio = 0.0
    for k in idx.keys():
        if num_hint:
            nk = _extract_leading_num(k)
            if nk and nk != num_hint:
                continue
        ratio = SequenceMatcher(None, key, k).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_k = k
    if best_k and best_ratio >= min_ratio:
        vals = idx.get(best_k) or []
        if vals:
            return vals[0]
    return None


def _parse_coord_tuple(token: str) -> list[float] | None:
    parts = [p for p in token.strip().split(",") if p != ""]
    if len(parts) < 2:
        return None
    try:
        lon = float(parts[0])
        lat = float(parts[1])
        return [lon, lat]
    except Exception:
        return None


def _parse_coords_text(text: str | None) -> list[list[float]]:
    if not text:
        return []
    out: list[list[float]] = []
    for token in re.split(r"\s+", text.strip()):
        c = _parse_coord_tuple(token)
        if c:
            out.append(c)
    return out


def _parse_placemark_geometry(pm: ET.Element) -> dict[str, Any] | None:
    point = pm.find(".//kml:Point/kml:coordinates", KML_NS)
    if point is not None:
        coords = _parse_coords_text(point.text)
        if coords:
            return {"type": "Point", "coordinates": coords[0]}

    line = pm.find(".//kml:LineString/kml:coordinates", KML_NS)
    if line is not None:
        coords = _parse_coords_text(line.text)
        if coords:
            return {"type": "LineString", "coordinates": coords}

    poly = pm.find(".//kml:Polygon/kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS)
    if poly is not None:
        coords = _parse_coords_text(poly.text)
        if coords:
            return {"type": "Polygon", "coordinates": [coords]}

    return None


def kmz_to_geojson(kmz_path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(kmz_path, "r") as zf:
        kml_names = [n for n in zf.namelist() if n.lower().endswith(".kml")]
        if not kml_names:
            raise ValueError("KMZ sem arquivo KML.")
        # Preferir doc.kml quando existir.
        kml_name = "doc.kml" if "doc.kml" in kml_names else kml_names[0]
        kml_bytes = zf.read(kml_name)

    root = ET.fromstring(sanitize_kml_xml(kml_bytes))
    features: list[dict[str, Any]] = []

    for pm in root.findall(".//kml:Placemark", KML_NS):
        geom = _parse_placemark_geometry(pm)
        if not geom:
            continue
        name = (pm.findtext("kml:name", default="", namespaces=KML_NS) or "").strip()
        desc = (pm.findtext("kml:description", default="", namespaces=KML_NS) or "").strip()
        features.append(
            {
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "name": name,
                    "description": desc,
                },
            }
        )

    return {"type": "FeatureCollection", "features": features}


def _point_index_from_geojson(geojson: dict[str, Any]) -> tuple[dict[str, list[tuple[float, float]]], int]:
    idx: dict[str, list[tuple[float, float]]] = {}
    total_points = 0
    for f in (geojson.get("features") or []):
        if not isinstance(f, dict):
            continue
        g = f.get("geometry") or {}
        if (g.get("type") or "").lower() != "point":
            continue
        coords = g.get("coordinates") or []
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        try:
            lon = float(coords[0])
            lat = float(coords[1])
        except Exception:
            continue

        p = f.get("properties") or {}
        name = str(p.get("name") or "").strip()
        variants = _name_variants(name)
        if not variants:
            continue
        for key in variants:
            idx.setdefault(key, []).append((lat, lon))
        total_points += 1
    return idx, total_points


def _point_number_index_from_geojson(geojson: dict[str, Any]) -> dict[str, list[tuple[float, float, str]]]:
    idx: dict[str, list[tuple[float, float, str]]] = {}
    for f in (geojson.get("features") or []):
        if not isinstance(f, dict):
            continue
        g = f.get("geometry") or {}
        if (g.get("type") or "").lower() != "point":
            continue
        coords = g.get("coordinates") or []
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        try:
            lon = float(coords[0])
            lat = float(coords[1])
        except Exception:
            continue
        p = f.get("properties") or {}
        name = str(p.get("name") or "").strip()
        num = _extract_leading_num(name)
        if num:
            idx.setdefault(num, []).append((lat, lon, name))
    return idx


def _best_number_hit(
    num_hint: str,
    candidates: list[str],
    by_num: dict[str, list[tuple[float, float, str]]],
) -> tuple[float, float] | None:
    if not num_hint:
        return None
    points = by_num.get(num_hint) or []
    if not points:
        return None
    if len(points) == 1:
        lat, lon, _name = points[0]
        return lat, lon

    candidate_keys = [c for c in (_norm_text(v) for v in candidates) if c]
    best: tuple[float, float] | None = None
    best_ratio = 0.0
    for lat, lon, name in points:
        key = _norm_text(name)
        if not key:
            continue
        ratio = max((SequenceMatcher(None, c, key).ratio() for c in candidate_keys), default=0.0)
        if ratio > best_ratio:
            best_ratio = ratio
            best = (lat, lon)
    return best if best and best_ratio >= 0.74 else None


def apply_locations_to_inventory(
    inventory_rows: list[dict[str, Any]],
    geojson: dict[str, Any],
    dry_run: bool = True,
    overwrite: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    by_name, points_total = _point_index_from_geojson(geojson)
    by_num = _point_number_index_from_geojson(geojson)
    by_ip: dict[str, tuple[float, float]] = {}
    for f in (geojson.get("features") or []):
        if not isinstance(f, dict):
            continue
        g = f.get("geometry") or {}
        if (g.get("type") or "").lower() != "point":
            continue
        coords = g.get("coordinates") or []
        if not isinstance(coords, list) or len(coords) < 2:
            continue
        try:
            lon = float(coords[0])
            lat = float(coords[1])
        except Exception:
            continue
        p = f.get("properties") or {}
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        ips = re.findall(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", name)
        for ip in ips:
            if ip not in by_ip:
                by_ip[ip] = (lat, lon)

    out_rows: list[dict[str, Any]] = []
    updated = 0
    skipped_has_loc = 0
    no_match = 0
    no_match_rows: list[dict[str, Any]] = []

    for row in (inventory_rows or []):
        if not isinstance(row, dict):
            continue
        r = dict(row)
        local = str(r.get("local") or "").strip()
        titulo = str(r.get("titulo") or "").strip()
        ip = str(r.get("ip") or "").strip()

        local_variants = list(_name_variants(local))
        titulo_variants = list(_name_variants(titulo))
        num_hint = _extract_leading_num(local) or _extract_leading_num(titulo)
        hit: tuple[float, float] | None = None

        for key_local in local_variants:
            if key_local in by_name:
                hit = by_name[key_local][0]
                break
        if not hit:
            for key_titulo in titulo_variants:
                if key_titulo in by_name:
                    hit = by_name[key_titulo][0]
                    break
        if not hit:
            for k in local_variants + titulo_variants:
                hit = _best_fuzzy_hit(k, by_name, num_hint=num_hint, min_ratio=0.88)
                if hit:
                    break
        if not hit and num_hint:
            hit = _best_fuzzy_hit(_norm_text(f"{num_hint} {titulo}"), by_name, num_hint=num_hint, min_ratio=0.84)
        if not hit and num_hint:
            hit = _best_fuzzy_hit(_norm_text(f"{num_hint} {local}"), by_name, num_hint=num_hint, min_ratio=0.84)
        if not hit and num_hint:
            hit = _best_number_hit(num_hint, [local, titulo], by_num)
        if not hit and (local_variants or titulo_variants):
            # ultimo fallback: aceita sem numero, mas com limite mais alto para evitar falso positivo
            for k in local_variants + titulo_variants:
                hit = _best_fuzzy_hit(k, by_name, num_hint="", min_ratio=0.92)
                if hit:
                    break
        if not hit and ip and ip in by_ip:
            hit = by_ip[ip]

        if not hit:
            no_match += 1
            no_match_rows.append(
                {
                    "ip": ip,
                    "titulo": titulo,
                    "local": local,
                }
            )
            out_rows.append(r)
            continue

        # Quando há mais de um ponto para a mesma chave, usamos o primeiro.
        lat, lon = hit
        has_latlon = bool(str(r.get("lat") or "").strip()) and bool(str(r.get("lon") or "").strip())
        if has_latlon and not overwrite:
            skipped_has_loc += 1
            out_rows.append(r)
            continue

        if not dry_run:
            r["lat"] = round(lat, 8)
            r["lon"] = round(lon, 8)
        updated += 1
        out_rows.append(r)

    summary = {
        "ok": True,
        "points_total": points_total,
        "updated": updated,
        "no_match": no_match,
        "skipped_has_loc": skipped_has_loc,
        "dry_run": bool(dry_run),
        "overwrite": bool(overwrite),
    }
    return out_rows, summary, no_match_rows


def generate_enriched_kmz(imported_kmz: Path, inventory_rows: list[dict[str, Any]], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    out = enrich_single_kmz(str(imported_kmz), inventory_rows, str(output_dir))
    return Path(out)


def read_geojson_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {}
