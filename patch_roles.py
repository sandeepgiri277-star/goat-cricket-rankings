#!/usr/bin/env python3
"""Patch all JSON data files with playing_role, bowl_type, bat_pos from ESPN data.

bat_pos is scraped per format — Tendulkar opened in ODIs but batted middle in Tests.
"""
import json, pickle, time, re, requests
from pathlib import Path

CACHE_DIR = Path("cricket_cache")
ROLES_CACHE = CACHE_DIR / "player_roles_api.pkl"
BATPOS_CACHE = CACHE_DIR / "batting_positions.pkl"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

ESPN_API = "https://site.api.espn.com/apis/common/v3/sports/cricket/athletes/{pid}"

JSON_CONFIGS = [
    {"jpath": "docs/rankings.json",      "cricket_class": 1, "label": "Test"},
    {"jpath": "docs/odi_rankings.json",   "cricket_class": 2, "label": "ODI"},
    {"jpath": "docs/t20i_rankings.json",  "cricket_class": 3, "label": "T20I"},
    {"jpath": "docs/ipl_rankings.json",   "cricket_class": 6, "label": "IPL"},
]

POSITION_MAP = {
    "opening batter": "opener",
    "top-order batter": "opener",
    "middle-order batter": "middle",
    "wicketkeeper batter": "keeper",
    "wicketkeeper": "keeper",
    "allrounder": "allrounder",
    "batting allrounder": "allrounder",
    "bowling allrounder": "allrounder",
    "batter": "middle",
    "bowler": None,
    "unknown": None,
}

SPIN_KEYWORDS = {"slow", "spin", "legbreak", "offbreak", "orthodox", "left-arm unorthodox",
                 "left-arm orthodox", "chinaman", "lbg", "ob", "slo", "sla"}
FAST_KEYWORDS = {"fast", "medium", "pace", "seam", "swing", "rfm", "rmf", "rf", "lf", "lfm", "lmf", "rm", "lm"}


def classify_bowl_style(bowl_style_list):
    if not bowl_style_list:
        return None
    for entry in bowl_style_list:
        desc = (entry.get("description") or "").lower()
        short = (entry.get("shortDescription") or "").lower()
        combined = desc + " " + short
        if any(k in combined for k in SPIN_KEYWORDS):
            return "spinner"
        if any(k in combined for k in FAST_KEYWORDS):
            return "fast"
    return None


def fetch_player_role(pid):
    url = ESPN_API.format(pid=pid)
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        if resp.status_code != 200:
            return None, None, None
        data = resp.json().get("athlete", {})
        pos_name = (data.get("position", {}).get("name") or "").strip().lower()
        bowl_style = data.get("bowlStyle")
        raw_role = POSITION_MAP.get(pos_name, pos_name if pos_name else None)
        if raw_role is None and pos_name in ("bowler", "unknown", ""):
            raw_role = classify_bowl_style(bowl_style)
        bowl_type = classify_bowl_style(bowl_style)
        return pos_name, raw_role, bowl_type
    except Exception:
        return None, None, None


def scrape_batting_position(pid, cricket_class=1):
    """Get most common batting position from career summary on Cricinfo stats page."""
    from bs4 import BeautifulSoup
    url = f"https://stats.espncricinfo.com/ci/engine/player/{pid}.html?class={cricket_class};template=results;type=batting"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        if resp.status_code != 200:
            return None
        soup = BeautifulSoup(resp.text, "lxml")
        for t in soup.select("table.engineTable"):
            cap = t.find("caption")
            if cap and "career summary" in cap.get_text(strip=True).lower():
                best_pos, best_inns = None, 0
                for row in t.find_all("tr"):
                    cells = [c.get_text(strip=True) for c in row.find_all("td")]
                    if len(cells) >= 4:
                        g = cells[0].lower()
                        m = re.match(r"(\d+)(?:st|nd|rd|th)\s+position", g)
                        if m:
                            pos_num = int(m.group(1))
                            inns = int(cells[3]) if cells[3].isdigit() else 0
                            if inns > best_inns:
                                best_inns = inns
                                best_pos = pos_num
                if best_pos:
                    return best_pos
    except Exception:
        pass
    return None


def load_cache():
    if ROLES_CACHE.exists():
        return pickle.load(open(ROLES_CACHE, "rb"))
    return {}


def save_cache(cache):
    with open(ROLES_CACHE, "wb") as f:
        pickle.dump(cache, f)


def get_name_to_pid():
    name_pid = {}
    for pkl in ["batting_aggregate.pkl", "bowling_aggregate.pkl",
                 "odi_bat_agg.pkl", "odi_bowl_agg.pkl",
                 "t20i_bowl_agg.pkl", "ipl_bowl_agg.pkl"]:
        path = CACHE_DIR / pkl
        if path.exists():
            try:
                df = pickle.load(open(path, "rb"))
                if "player_name" in df.columns and "player_id" in df.columns:
                    for _, r in df.iterrows():
                        pid = r.get("player_id")
                        if pid and not (isinstance(pid, float) and pid != pid):
                            name_pid[r["player_name"]] = int(pid)
            except Exception as e:
                print(f"  Warning: couldn't load {pkl}: {e}", flush=True)
    return name_pid


def scrape_stats_agg(cricket_class, stat_type="batting", min_matches=15, extra_params=""):
    from bs4 import BeautifulSoup
    base = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class={cricket_class}{extra_params};template=results;type={stat_type};"
        f"qualmin1={min_matches};qualval1=matches;size=200"
    )
    all_rows = []
    page = 1
    while True:
        url = f"{base};page={page}"
        print(f"    Fetching page {page}...", flush=True)
        resp = requests.get(url, headers=HEADERS, timeout=30)
        soup = BeautifulSoup(resp.text, "lxml")
        tables = soup.select("table.engineTable")
        if not tables:
            break
        data_table = max(tables, key=lambda t: len(t.find_all("tr")))
        rows = data_table.find_all("tr")
        header_tr = data_table.select_one("tr.headlinks") or rows[0]
        cols = [c.get_text(strip=True) for c in header_tr.find_all(["th", "td"])]
        page_rows = []
        for tr in rows:
            if tr is header_tr:
                continue
            cells = tr.find_all("td")
            if len(cells) != len(cols):
                continue
            row = {}
            for col_name, td in zip(cols, cells):
                if col_name == "Player":
                    link = td.find("a")
                    raw = td.get_text(strip=True)
                    parts = re.match(r"^(.+?)\(([^)]+)\)$", raw.strip())
                    row["player_name"] = parts.group(1).strip() if parts else raw.strip()
                    if link and link.get("href"):
                        m_id = re.search(r"/player/(\d+)\.html", link["href"])
                        if m_id:
                            row["player_id"] = int(m_id.group(1))
            if "player_id" in row:
                page_rows.append(row)
        if not page_rows:
            break
        all_rows.extend(page_rows)
        has_next = any(a.get_text(strip=True) == "Next" for a in soup.find_all("a"))
        if has_next:
            page += 1
            time.sleep(0.5)
        else:
            break
    return {r["player_name"]: r["player_id"] for r in all_rows}


def needs_batting_position(pos, bat_r, bowl_r):
    """Should we scrape batting position for this player?"""
    if pos in ("top-order batter", "opening batter", "middle-order batter",
               "batter", "wicketkeeper batter", "wicketkeeper"):
        return True
    if "allrounder" in pos and bat_r > 0:
        return True
    if pos in ("unknown", "") and bat_r > bowl_r:
        return True
    return False


def main():
    print("=== Building name -> player_id map ===", flush=True)
    name_pid = get_name_to_pid()

    scrape_configs = [
        ("Test bat",  {"cc": 1, "st": "batting",  "mm": 15}),
        ("Test bowl", {"cc": 1, "st": "bowling",  "mm": 15}),
        ("ODI bat",   {"cc": 2, "st": "batting",  "mm": 15}),
        ("ODI bowl",  {"cc": 2, "st": "bowling",  "mm": 15}),
        ("T20I bat",  {"cc": 3, "st": "batting",  "mm": 15}),
        ("T20I bowl", {"cc": 3, "st": "bowling",  "mm": 15}),
        ("IPL bat",   {"cc": 6, "st": "batting",  "mm": 15, "ep": ";trophy=117"}),
        ("IPL bowl",  {"cc": 6, "st": "bowling",  "mm": 15, "ep": ";trophy=117"}),
    ]
    for label, cfg in scrape_configs:
        print(f"  Scraping {label} aggregate for more IDs...", flush=True)
        extra = scrape_stats_agg(cfg["cc"], cfg.get("st", "batting"), cfg.get("mm", 15), cfg.get("ep", ""))
        name_pid.update(extra)
        print(f"    Got {len(extra)} names", flush=True)
        time.sleep(1)

    print(f"  Total: {len(name_pid)} unique player IDs\n", flush=True)

    # Collect all player names across all JSONs
    all_json_names = set()
    for cfg in JSON_CONFIGS:
        jpath = cfg["jpath"]
        if Path(jpath).exists():
            with open(jpath) as f:
                data = json.load(f)
            for k in ["all_players", "batting_top25", "bowling_top25", "allrounder_top25"]:
                for p in data.get(k, []):
                    all_json_names.add(p.get("name", ""))

    pids_to_fetch = {}
    for name in all_json_names:
        pid = name_pid.get(name)
        if pid:
            pids_to_fetch[name] = pid

    print(f"  {len(pids_to_fetch)}/{len(all_json_names)} JSON players have player IDs\n", flush=True)

    # Fetch ESPN API roles (cached)
    cache = load_cache()
    unique_pids = set(pids_to_fetch.values())
    to_fetch = [pid for pid in unique_pids if pid not in cache]
    print(f"=== Fetching roles from ESPN API for {len(to_fetch)} players (cached: {len(cache)}) ===", flush=True)

    for i, pid in enumerate(to_fetch):
        pos, role, bowl_type = fetch_player_role(pid)
        cache[pid] = {"pos": pos, "role": role, "bowl_type": bowl_type}
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(to_fetch)} fetched...", flush=True)
            save_cache(cache)
        time.sleep(0.25)

    save_cache(cache)
    print(f"  Done. Total cached: {len(cache)}\n", flush=True)

    # Rebuild roles from cache
    for pid in cache:
        entry = cache[pid]
        if not isinstance(entry, dict):
            continue
        pos = (entry.get("pos") or "").strip().lower()
        role = POSITION_MAP.get(pos)
        if role is None:
            role = entry.get("bowl_type")
        entry["role"] = role

    save_cache(cache)

    # Build name -> bowl_type map (format-independent, from ESPN)
    name_bowl_type = {}
    for name, pid in pids_to_fetch.items():
        entry = cache.get(pid, {})
        if isinstance(entry, dict) and entry.get("bowl_type"):
            name_bowl_type[name] = entry["bowl_type"]

    # ── Per-format batting position scraping ─────────────────────────────
    # Cache key = (pid, cricket_class) so Tendulkar gets opener for ODIs, middle for Tests
    batpos_cache = {}
    if BATPOS_CACHE.exists():
        try:
            batpos_cache = pickle.load(open(BATPOS_CACHE, "rb"))
        except Exception:
            batpos_cache = {}

    # Migrate old cache format: if keys are plain ints, it's the old (pid-only) format
    if batpos_cache and any(isinstance(k, int) for k in batpos_cache):
        print("  Migrating old batpos cache (pid-only) -> clearing to re-scrape per format", flush=True)
        batpos_cache = {}

    for cfg in JSON_CONFIGS:
        jpath = cfg["jpath"]
        cc = cfg["cricket_class"]
        label = cfg["label"]
        if not Path(jpath).exists():
            continue

        with open(jpath) as f:
            data = json.load(f)

        # Collect stats for players in this format
        format_stats = {}
        for p in data.get("all_players", []):
            n = p.get("name", "")
            if n:
                format_stats[n] = p

        # Find players that need batting position for this format
        needs = []
        for name, stats in format_stats.items():
            pid = pids_to_fetch.get(name)
            if not pid:
                continue
            entry = cache.get(pid, {})
            if not isinstance(entry, dict):
                continue
            pos = (entry.get("pos") or "").strip().lower()
            bat_r = stats.get("bat_rating", 0) or 0
            bowl_r = stats.get("bowl_rating", 0) or 0
            if needs_batting_position(pos, bat_r, bowl_r):
                if (pid, cc) not in batpos_cache:
                    needs.append((name, pid))

        if needs:
            print(f"  Scraping {label} batting positions for {len(needs)} players...", flush=True)
            for i, (name, pid) in enumerate(needs):
                bp = scrape_batting_position(pid, cricket_class=cc)
                batpos_cache[(pid, cc)] = bp
                if (i + 1) % 25 == 0:
                    print(f"    {i+1}/{len(needs)}...", flush=True)
                    with open(BATPOS_CACHE, "wb") as f:
                        pickle.dump(batpos_cache, f)
                time.sleep(0.3)
            with open(BATPOS_CACHE, "wb") as f:
                pickle.dump(batpos_cache, f)
            print(f"    Done.", flush=True)
        else:
            print(f"  {label}: all batting positions cached.", flush=True)

    with open(BATPOS_CACHE, "wb") as f:
        pickle.dump(batpos_cache, f)

    # ── Patch each JSON with format-specific bat_pos ─────────────────────
    from collections import Counter
    print("\n=== Patching JSON files ===", flush=True)

    for cfg in JSON_CONFIGS:
        jpath = cfg["jpath"]
        cc = cfg["cricket_class"]
        label = cfg["label"]
        if not Path(jpath).exists():
            continue

        with open(jpath) as f:
            data = json.load(f)

        # Build format-specific name -> role and name -> bat_pos
        format_stats = {}
        for p in data.get("all_players", []):
            format_stats[p.get("name", "")] = p

        name_role = {}
        name_bat_pos = {}
        for name, pid in pids_to_fetch.items():
            entry = cache.get(pid, {})
            if not isinstance(entry, dict):
                continue
            pos = (entry.get("pos") or "").strip().lower()
            role = POSITION_MAP.get(pos)
            stats = format_stats.get(name, {})
            bat_r = stats.get("bat_rating", 0) or 0
            bowl_r = stats.get("bowl_rating", 0) or 0

            # Get format-specific batting position
            bp = batpos_cache.get((pid, cc))
            if bp:
                name_bat_pos[name] = "opener" if bp <= 2 else "middle"

            if pos == "top-order batter":
                if bp and bp <= 2:
                    role = "opener"
                elif bp and bp >= 3:
                    role = "middle"

            if role is None and pos in ("unknown", ""):
                if bowl_r > bat_r:
                    role = entry.get("bowl_type")
                elif bat_r > 0:
                    if bp and bp <= 2:
                        role = "opener"
                    else:
                        role = "middle"

            if role:
                name_role[name] = role

        dist = Counter(name_role.values())
        print(f"  {label} roles: {dict(dist.most_common())}")

        # Build lookup from all_players first
        ap_roles = {}
        for p in data.get("all_players", []):
            name = p.get("name", "")
            if name in name_role:
                ap_roles[name] = name_role[name]

        patched = 0
        for list_key in ["all_players", "batting_top25", "bowling_top25", "allrounder_top25"]:
            for pl in data.get(list_key, []):
                name = pl.get("name", "")
                role = name_role.get(name) or ap_roles.get(name)
                if role:
                    pl["playing_role"] = role
                    patched += 1
                bt = name_bowl_type.get(name)
                if bt:
                    pl["bowl_type"] = bt
                bp = name_bat_pos.get(name)
                if bp:
                    pl["bat_pos"] = bp

        with open(jpath, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        print(f"  {jpath}: patched {patched} entries", flush=True)

    print("\nDone!", flush=True)


if __name__ == "__main__":
    main()
