# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The RadioFoundry Authors
# Copyright (c) 2026 The RadioFoundry-cp-builder Authors
"""The Builder tab's data snapshots (site/static/js/codeplug/builder/data/).

Three sources, written as JavaScript modules so the page needs no server and no
third-party proxy:

- ``talkgroups.js``: every Brandmeister talkgroup with the country and continent
  its id belongs to (rfoundrysite/builder_geo.py), 1,848 records at most a few
  hundred kilobytes.
- ``repeaters.js``: analog repeaters from HearHam's open dump, merged with URE's
  Spanish map (URE wins where both describe a repeater, since it is the
  coordinator's own list and the only source with useful Spanish UHF data).
- ``meta.js``: when each was fetched, how many rows it holds and where from, so
  the page can say how old its data is.

Brandmeister sends no CORS headers, so its repeater list and talkgroup list
cannot be read from a page at all; this is why they are committed. Rerun after a
release or on a schedule (the workflow in .github/workflows/builder-data.yml):

    python3 site/rfoundrysite/builder_data.py

``--offline`` rewrites the modules from the cached HTTP answers under
``build/builder-cache/`` without touching the network.
"""

import argparse
import concurrent.futures
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

if __package__ in (None, ""):	# run as a script: site/ on the path, the package imported by name
	import os as _os
	import sys as _sys

	_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
	from rfoundrysite import builder_geo, repo
else:
	from . import builder_geo, repo

# Brandmeister's Halligan API v2 (https://api.brandmeister.network/docs). The
# device list is cached by Brandmeister and its documentation asks clients not to
# poll it more than once every 15 minutes, which a build comfortably respects.
BM_DEVICES = "https://api.brandmeister.network/v2/device?repeater=true"
BM_DEVICE_TALKGROUPS = "https://api.brandmeister.network/v2/device/%d/talkgroup"
BM_TALKGROUPS = "https://api.brandmeister.network/v2/talkgroup"
HEARHAM = "https://hearham.com/api/repeaters/v1"
URE_BANDS = ("repe144", "repe432")
URE_BAND = "https://www.ure.es/appure/repetidores-nuevos_test/api.php?band=%s"

USER_AGENT = "RadioFoundry site builder (+https://github.com/RadioFoundry/RadioFoundry)"
MAX_BYTES = 60_000_000
TIMEOUT = 60.0

OUT_DIR = repo.path("site", "static", "js", "codeplug", "builder", "data")
CACHE_DIR = repo.path("build", "builder-cache")

# Repeaters live between 10 m and 23 cm; anything else is a typo upstream.
MIN_MHZ, MAX_MHZ = 28.0, 1300.0


# --- fetching ---------------------------------------------------------------


def fetch(url, cache=None, *, offline=False, timeout=TIMEOUT, retries=6, resume=False):
    """A URL's bytes, optionally through a cache file so a rebuild is offline.

    Brandmeister answers 429 when asked too fast; a 429 or a 5xx is retried with
    a growing pause (and whatever Retry-After says), and a cached answer is used
    when there is one, so a run interrupts and resumes without losing work.
    """
    path = os.path.join(cache, re.sub(r"[^A-Za-z0-9]+", "-", url).strip("-") + ".json") if cache else None
    if offline or (resume and path and os.path.exists(path)):
        if not path or not os.path.exists(path):
            raise SystemExit("builder_data.py: --offline needs %s" % (path or "a cache directory"))
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", "Accept-Encoding": "gzip"})
    raw, encoding, attempt = None, "", 0
    while True:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(MAX_BYTES + 1)
                encoding = (response.headers.get("Content-Encoding") or "").lower()
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt >= retries:
                if path and os.path.exists(path):
                    with open(path, encoding="utf-8") as f:
                        return json.load(f)
                raise SystemExit("builder_data.py: %s failed: %s" % (url, exc)) from exc
            pause = float(exc.headers.get("Retry-After") or 0) or min(30.0, 2.0 ** attempt)
            time.sleep(pause)
            attempt += 1
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt >= retries:
                if path and os.path.exists(path):
                    with open(path, encoding="utf-8") as f:
                        return json.load(f)
                raise SystemExit("builder_data.py: %s failed: %s" % (url, exc)) from exc
            time.sleep(min(30.0, 2.0 ** attempt))
            attempt += 1
    if len(raw) > MAX_BYTES:
        raise SystemExit("builder_data.py: %s exceeds %d bytes" % (url, MAX_BYTES))
    if encoding == "gzip":
        raw = gzip.decompress(raw)
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit("builder_data.py: %s did not send JSON" % url) from exc
    if path:
        os.makedirs(cache, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    return data


# --- small parsers ----------------------------------------------------------


def number(value):
    try:
        text = str(value).strip().replace(",", ".")
        return float(text) if text else None
    except (TypeError, ValueError):
        return None


def integer(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def round4(value):
    return None if value is None else round(value, 4)


def text(value, limit):
    return " ".join(str(value or "").split())[:limit]


def mhz(value):
    """A Brandmeister frequency string ('438.4500') in MHz, if plausible."""
    mhz_value = number(value)
    return round(mhz_value, 6) if mhz_value is not None and 1.0 <= mhz_value <= 3000.0 else None


# --- sources ----------------------------------------------------------------


def normalize_device(raw):
    """A Brandmeister device as a compact repeater, or None.

    In the API ``tx`` is what the repeater transmits (the user's receive
    frequency) and ``rx`` what it receives (the user's transmit frequency).
    """
    if not isinstance(raw, dict):
        return None
    callsign = text(raw.get("callsign"), 16).upper()
    down, up = mhz(raw.get("tx")), mhz(raw.get("rx"))
    lat, lon = number(raw.get("lat")), number(raw.get("lng"))
    device_id = integer(raw.get("id"))
    if not callsign or down is None or up is None or lat is None or lon is None:
        return None
    if device_id is None or not 100_000 <= device_id <= 999_999:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    color = integer(raw.get("colorcode"))
    return {
        "id": device_id,
        "callsign": callsign,
        "city": text(raw.get("city"), 40),
        "down": down,
        "up": up,
        "lat": round4(lat),
        "lon": round4(lon),
        "color": max(0, min(15, color or 0)),
        "status": integer(raw.get("status")),
    }


def normalize_hearham(raw):
    """A HearHam entry as a compact analog repeater, or None.

    ``frequency`` is the repeater's output and ``offset`` the shift the user's
    radio applies, so the user transmits on ``frequency + offset``.
    """
    if not isinstance(raw, dict):
        return None
    mode = text(raw.get("mode"), 24).upper()
    if "FM" not in mode:
        return None
    callsign = text(raw.get("callsign"), 16).upper()
    if not re.search(r"[A-Z]", callsign):
        return None	# "146.88" and the like: a frequency where a callsign belongs
    freq_hz, offset_hz = number(raw.get("frequency")), number(raw.get("offset")) or 0.0
    lat, lon = number(raw.get("latitude")), number(raw.get("longitude"))
    if not callsign or freq_hz is None or lat is None or lon is None:
        return None
    down = round(freq_hz / 1e6, 6)
    up = round((freq_hz + offset_hz) / 1e6, 6)
    if not (MIN_MHZ <= down <= MAX_MHZ and MIN_MHZ <= up <= MAX_MHZ):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if integer(raw.get("operational")) == 0:
        return None
    if text(raw.get("restriction"), 20).lower() == "private":
        return None
    return {
        "callsign": callsign,
        "down": down,
        "up": up,
        "tone": clean_tone(raw.get("encode")),
        "lat": round4(lat),
        "lon": round4(lon),
        "mode": text(mode, 12),
        "city": text(raw.get("city"), 28),
        "source": "h",
    }


TONES = re.compile(r"^(?:D?[0-7]{1,3}[NI]?|[0-9]{2,3}(?:\.[0-9])?)$")


def clean_tone(value):
    """A tone as the radio stores it, or "". A decimal comma is the same tone."""
    tone = text(value, 8).upper()
    tone = re.sub(r"^(\d{2,3}),(\d)$", r"\1.\2", tone)
    if not tone or tone in ("NONE", "OFF", "CSQ", "-") or not TONES.match(tone):
        return ""
    return tone


def parse_ure_shift(raw):
    """'-600 kHz', '- 7.6 MHz', '-7.6MHz' and a bare '-600' all in MHz."""
    value = number(raw)
    if value is None:
        return 0.0
    lowered = str(raw).lower()
    if "khz" in lowered:
        return round(value / 1000, 6)
    if "mhz" in lowered:
        return round(value, 6)
    return round(value / 1000 if abs(value) >= 100 else value, 6)


def normalize_ure(raw, band):
    """A URE map row as a compact analog repeater, or None."""
    if not isinstance(raw, dict):
        return None
    mode = text(raw.get("mode"), 24).upper()
    # FM Echolink is still FM; APRS on 2 m is packet, not a voice repeater.
    if not mode.startswith("FM") or "APRS" in mode:
        return None
    callsign = text(raw.get("name"), 16).upper()
    if not re.search(r"[A-Z]", callsign):
        return None
    down = number(text(raw.get("freq"), 24))
    lat, lon = number(raw.get("lat")), number(raw.get("lng"))
    if not callsign or down is None or lat is None or lon is None:
        return None
    if not (MIN_MHZ <= down <= MAX_MHZ and -90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    up = round(down + parse_ure_shift(raw.get("shift")), 6)
    if not MIN_MHZ <= up <= MAX_MHZ:
        return None
    return {
        "callsign": callsign,
        "down": round(down, 6),
        "up": up,
        "tone": clean_tone(str(raw.get("subtono") or "").replace(" Hz", "")),
        "lat": round4(lat),
        "lon": round4(lon),
        "mode": "FM",
        "city": text(raw.get("provincia"), 28),
        "source": "u",
        "band": band,
    }


def dmr_repeaters(devices_raw, talkgroups_by_device=None):
    """Brandmeister's repeaters, with the static talkgroups of each where known."""
    out, seen = [], set()
    talkgroups_by_device = talkgroups_by_device or {}
    for raw in devices_raw if isinstance(devices_raw, list) else []:
        device = normalize_device(raw)
        if not device or device["id"] in seen:
            continue
        seen.add(device["id"])
        out.append({
            "id": device["id"],
            "callsign": device["callsign"],
            "city": device["city"],
            "down": device["down"],
            "up": device["up"],
            "lat": device["lat"],
            "lon": device["lon"],
            "color": device["color"],
            "status": device["status"],
            "talkgroups": talkgroups_by_device.get(device["id"], []),
        })
    out.sort(key=lambda row: row["callsign"])
    return out


def analog_repeaters(hearham_raw, ure_braw):
    """URE and HearHam, merged on callsign plus output frequency.

    URE's record is kept where both describe a repeater: it is the national
    coordinator's own list. A tone only HearHam has is filled in rather than lost.
    """
    analog, ure_keys = [], set()
    for band, raw in ure_braw.items():
        for item in raw.get("items", []) if isinstance(raw, dict) else []:
            row = normalize_ure(item, band)
            if row:
                ure_keys.add((row["callsign"], round(row["down"] * 1000)))
                analog.append(row)
    for raw in hearham_raw if isinstance(hearham_raw, list) else []:
        row = normalize_hearham(raw)
        if not row:
            continue
        key = (row["callsign"], round(row["down"] * 1000))
        if key in ure_keys:
            # URE's record is already in: only lend it a tone it lacks
            for existing in analog:
                if (existing["callsign"], round(existing["down"] * 1000)) == key and not existing["tone"] and row["tone"]:
                    existing["tone"] = row["tone"]
            continue
        analog.append(row)
    analog.sort(key=lambda row: (row["lat"] is None, row["callsign"], row["down"]))
    return analog


def device_talkgroups(devices, cache_dir, *, offline=False, workers=2, limit=32, budget=None):
    """{device id: [[talkgroup, slot], ...]} for every repeater, in API order.

    Brandmeister publishes no bulk endpoint for these, so one request per
    repeater is the only way to keep the Builder tab's "the first static
    talkgroup is the default contact" rule without a server. The endpoint is
    throttled: a 429 carries a Retry-After of a minute or more, so this is a
    long, resumable job rather than a quick one. Every answer is cached under
    build/builder-cache/, a cached answer is reused on the next run, and a
    repeater that still has none is left out of the snapshot (the page then
    offers TG 9, or the talkgroup table, for it). ``budget`` stops the run after
    that many new requests, so a scheduled job can work through the list over
    several runs.
    """
    ids = [row["id"] for row in dmr_repeaters(devices)] if isinstance(devices, list) else []
    out, asked = {}, 0

    def one(device_id):
        nonlocal asked
        path = os.path.join(cache_dir, re.sub(r"[^A-Za-z0-9]+", "-", BM_DEVICE_TALKGROUPS % device_id).strip("-") + ".json")
        if not offline and not os.path.exists(path):
            asked += 1
            if budget is not None and asked > budget:
                return device_id, None
        try:
            raw = fetch(BM_DEVICE_TALKGROUPS % device_id, cache_dir, offline=offline, timeout=30.0, resume=True)
        except SystemExit:
            # no answer for this repeater yet (throttled, or not in the cache):
            # the page then uses its country's talkgroup, so the snapshot stays
            # complete and a later run fills the list in
            return device_id, []
        pairs, seen = [], set()
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict):
                continue
            tg = integer(item.get("talkgroup"))
            if tg is None or tg <= 0 or tg in seen:
                continue
            seen.add(tg)
            slot = integer(item.get("slot"))
            pairs.append([tg, slot if slot in (1, 2) else 0])
        return device_id, pairs[:limit]

    done = 0
    with concurrent.futures.ThreadPoolExecutor(workers) as pool:
        for device_id, pairs in pool.map(one, ids):
            if pairs is None:
                continue
            out[device_id] = pairs
            done += 1
            if done % 100 == 0:
                print("  talkgroups: %d/%d" % (done, len(ids)), file=sys.stderr, flush=True)
    print("  talkgroups: %d of %d repeaters have a list" % (len(out), len(ids)), file=sys.stderr, flush=True)
    return out


def talkgroup_index(raw):
    """Brandmeister's id-to-name map, with each talkgroup's place."""
    return builder_geo.build_index(raw)


# --- rendering --------------------------------------------------------------


def js_string(value):
    """A JSON string that is also safe inside a JavaScript module."""
    return json.dumps(value, ensure_ascii=False)


def render_module(name, summary, body, meta):
    """A generated data module: header, counts, the const, the export."""
    stamp = time.strftime("%Y-%m-%d", time.gmtime(meta["fetched_at"]))
    lines = [
        "// SPDX-License-Identifier: MIT",
        "// Copyright (c) 2026 The RadioFoundry Authors",
        "// Copyright (c) 2026 The RadioFoundry-cp-builder Authors",
        "// Generated by site/rfoundrysite/builder_data.py on %s: %s" % (stamp, summary),
        "// Rerun that script to refresh it; do not edit this file.",
        "",
        "export const FETCHED_AT = %s;" % js_string(stamp),
        "export const SOURCE = %s;" % js_string(meta["source"]),
        "",
        "export const %s = %s;" % (name, body),
        "",
    ]
    return "\n".join(lines)


def render_talkgroups(index, meta):
    rows = [[item["tg"], item["name"], item["continent"], item["country"] or ""] for item in index]
    body = "[\n" + "\n".join("\t[%d, %s, %s, %s]," % (
        tg, js_string(name), js_string(continent), js_string(country)) for tg, name, continent, country in rows) + "\n]"
    return render_module(
        "TALKGROUPS",
        "Brandmeister's talkgroups and the country each id belongs to (%d records)." % len(rows),
        body, meta)


def render_dmr_repeaters(rows, meta):
    body = "[\n" + "\n".join("\t[%d, %s, %s, %s, %d, %s, %s, %s, %s, %s]," % (
        r["id"], js_string(r["callsign"]), fmt(r["down"]), fmt(r["up"]), r["color"],
        fmt(r["lat"]), fmt(r["lon"]), js_string(r["city"]),
        "null" if r["status"] is None else str(r["status"]),
        json.dumps(r["talkgroups"], separators=(",", ":"))) for r in rows) + "\n]"
    return render_module(
        "DMR_REPEATERS",
        "Brandmeister repeaters and their static talkgroups (%d repeaters)." % len(rows),
        body, meta)


def render_analog_repeaters(rows, meta):
    body = "[\n" + "\n".join("\t[%s, %s, %s, %s, %s, %s, %s, %s, %s]," % (
        js_string(r["callsign"]), fmt(r["down"]), fmt(r["up"]), js_string(r.get("tone", "")),
        fmt(r.get("lat")), fmt(r.get("lon")), js_string(r.get("mode", "")), js_string(r.get("city", "")),
        js_string(r["source"])) for r in rows) + "\n]"
    return render_module(
        "ANALOG_REPEATERS",
        "Analog repeaters from HearHam and URE (%d rows)." % len(rows),
        body, meta)


def fmt(value):
    """A number for the module, or null: no trailing zeros, no exponent."""
    if value is None:
        return "null"
    if isinstance(value, int):
        return str(value)
    return ("%.6f" % value).rstrip("0").rstrip(".")


def render_meta(meta):
    lines = [
        "// SPDX-License-Identifier: MIT",
        "// Copyright (c) 2026 The RadioFoundry Authors",
        "// Copyright (c) 2026 The RadioFoundry-cp-builder Authors",
        "// Generated by site/rfoundrysite/builder_data.py; rerun that script to refresh it.",
        "",
        "export const SOURCES = %s;" % json.dumps(meta["sources"], ensure_ascii=False, indent="\t"),
        "",
    ]
    return "\n".join(lines)


# --- main -------------------------------------------------------------------

DEFAULT_SOURCES = {
    "brandmeister_devices": BM_DEVICES,
    "brandmeister_talkgroups": BM_TALKGROUPS,
    "hearham": HEARHAM,
    "ure_repe144": URE_BAND % "repe144",
    "ure_repe432": URE_BAND % "repe432",
}


def build(out_dir=OUT_DIR, cache_dir=CACHE_DIR, offline=False, only=None, sources=DEFAULT_SOURCES,
          with_talkgroups=True, budget=None):
    """Fetch, normalise and write the modules. Returns what was written."""
    os.makedirs(out_dir, exist_ok=True)
    now = time.time()
    written = {}
    meta_sources = []

    if only in (None, "talkgroups"):
        raw = fetch(sources["brandmeister_talkgroups"], cache_dir, offline=offline)
        index = talkgroup_index(raw)
        meta = {"fetched_at": now, "source": sources["brandmeister_talkgroups"]}
        written["talkgroups.js"] = render_talkgroups(index, meta)
        meta_sources.append({"id": "talkgroups", "name": "Brandmeister talkgroups",
                             "url": sources["brandmeister_talkgroups"], "rows": len(index)})

    if only in (None, "repeaters"):
        devices = fetch(sources["brandmeister_devices"], cache_dir, offline=offline)
        dmr = None
        if with_talkgroups:
            dmr = dmr_repeaters(devices, device_talkgroups(devices, cache_dir, offline=offline, budget=budget))
            written["dmr-repeaters.js"] = render_dmr_repeaters(dmr, {"fetched_at": now, "source": sources["brandmeister_devices"]})
            meta_sources.append({"id": "b", "name": "Brandmeister repeaters", "url": sources["brandmeister_devices"], "rows": len(dmr)})
        hearham = fetch(sources["hearham"], cache_dir, offline=offline)
        ure = {band: fetch(sources["ure_" + band], cache_dir, offline=offline) for band in URE_BANDS}
        analog = analog_repeaters(hearham, ure)
        written["analog-repeaters.js"] = render_analog_repeaters(analog, {"fetched_at": now, "source": sources["hearham"]})
        counts = {}
        for row in analog:
            counts[row["source"]] = counts.get(row["source"], 0) + 1
        for source, label, url in (("u", "URE (Spain)", URE_BAND % "repe144"),
                                   ("h", "HearHam", sources["hearham"])):
            meta_sources.append({"id": source, "name": label, "url": url, "rows": counts.get(source, 0)})

    meta = {"sources": meta_sources, "generated_at": time.strftime("%Y-%m-%d", time.gmtime(now))}
    written["meta.js"] = render_meta(meta)

    for name, text in written.items():
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            f.write(text)
    return written


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write the Builder tab's data snapshots.")
    parser.add_argument("--out", default=OUT_DIR)
    parser.add_argument("--cache", default=CACHE_DIR)
    parser.add_argument("--offline", action="store_true", help="use cached answers, no network")
    parser.add_argument("--only", choices=("talkgroups", "repeaters"), default=None)
    parser.add_argument("--no-talkgroups", action="store_true",
                        help="skip the per-repeater static talkgroups (one request per repeater)")
    parser.add_argument("--talkgroup-budget", type=int, default=None,
                        help="stop after this many new per-repeater requests; a later run resumes")
    args = parser.parse_args(argv)
    written = build(args.out, args.cache, args.offline, args.only,
                    with_talkgroups=not args.no_talkgroups, budget=args.talkgroup_budget)
    for name, text in written.items():
        print("%-14s %7.1f kB" % (name, len(text.encode("utf-8")) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
