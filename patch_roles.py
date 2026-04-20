#!/usr/bin/env python3
"""Patch all JSON data files with playing_role from ESPN API."""
import json, pickle, time, re, requests
from pathlib import Path

CACHE_DIR = Path("cricket_cache")
ROLES_CACHE = CACHE_DIR / "player_roles_api.pkl"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

ESPN_API = "https://site.api.espn.com/apis/common/v3/sports/cricket/athletes/{pid}"
BATPOS_CACHE = CACHE_DIR / "batting_positions.pkl"

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
    "bowler": None,       # resolved via bowl style
    "unknown": None,      # resolved via bowl style if available
}

SPIN_KEYWORDS = {"slow", "spin", "legbreak", "offbreak", "orthodox", "left-arm unorthodox",
                 "left-arm orthodox", "chinaman", "lbg", "ob", "slo", "sla"}
FAST_KEYWORDS = {"fast", "medium", "pace", "seam", "swing", "rfm", "rmf", "rf", "lf", "lfm", "lmf", "rm", "lm"}


def classify_bowl_style(bowl_style_list):
    """Determine spinner vs fast from ESPN bowlStyle data."""
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
    """Fetch position and bowling style from ESPN API, return normalized role."""
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
    """Get most common batting position from career summary on stats page."""
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
    """Build name->pid from all available aggregate pickles."""
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
    """Scrape batting/bowling aggregate for name->pid mapping."""
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
        from bs4 import BeautifulSoup
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
                        m = re.search(r"/player/(\d+)\.html", link["href"])
                        if m:
                            row["player_id"] = int(m.group(1))
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


def main():
    print("=== Building name -> player_id map ===", flush=True)
    name_pid = get_name_to_pid()

    # Fill gaps from stats scraping for formats missing or incompatible pickles
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

    # Collect all player names from JSONs
    all_json_names = set()
    for jpath in ["docs/rankings.json", "docs/odi_rankings.json", "docs/t20i_rankings.json", "docs/ipl_rankings.json"]:
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

    # Rebuild roles from cache with updated mapping
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

    # Scrape batting positions for "top-order batter" and "unknown" batter players
    batpos_cache = {}
    if BATPOS_CACHE.exists():
        batpos_cache = pickle.load(open(BATPOS_CACHE, "rb"))

    all_player_stats = {}
    for jpath in ["docs/rankings.json", "docs/odi_rankings.json", "docs/t20i_rankings.json", "docs/ipl_rankings.json"]:
        if Path(jpath).exists():
            with open(jpath) as f:
                d = json.load(f)
            for p in d.get("all_players", []):
                n = p.get("name", "")
                if n not in all_player_stats:
                    all_player_stats[n] = p

    needs_batpos = []
    for name, pid in pids_to_fetch.items():
        entry = cache.get(pid, {})
        if not isinstance(entry, dict):
            continue
        pos = (entry.get("pos") or "").strip().lower()
        stats = all_player_stats.get(name, {})
        bat_r = stats.get("bat_rating", 0) or 0
        bowl_r = stats.get("bowl_rating", 0) or 0
        if pos == "top-order batter" or (pos in ("unknown", "") and bat_r > bowl_r):
            if pid not in batpos_cache:
                needs_batpos.append((name, pid))

    if needs_batpos:
        print(f"  Scraping batting positions for {len(needs_batpos)} players...", flush=True)
        for i, (name, pid) in enumerate(needs_batpos):
            bp = scrape_batting_position(pid)
            batpos_cache[pid] = bp
            if (i + 1) % 25 == 0:
                print(f"    {i+1}/{len(needs_batpos)}...", flush=True)
                with open(BATPOS_CACHE, "wb") as f:
                    pickle.dump(batpos_cache, f)
            time.sleep(0.3)
        with open(BATPOS_CACHE, "wb") as f:
            pickle.dump(batpos_cache, f)
        print(f"    Done.", flush=True)

    # Build final name -> role map
    name_role = {}
    for name, pid in pids_to_fetch.items():
        entry = cache.get(pid, {})
        if not isinstance(entry, dict):
            continue
        pos = (entry.get("pos") or "").strip().lower()
        role = POSITION_MAP.get(pos)
        stats = all_player_stats.get(name, {})
        bat_r = stats.get("bat_rating", 0) or 0
        bowl_r = stats.get("bowl_rating", 0) or 0

        if pos == "top-order batter":
            bp = batpos_cache.get(pid)
            if bp and bp <= 2:
                role = "opener"
            elif bp and bp >= 3:
                role = "middle"

        if role is None and pos in ("unknown", ""):
            if bowl_r > bat_r:
                role = entry.get("bowl_type")
            elif bat_r > 0:
                bp = batpos_cache.get(pid)
                if bp and bp <= 2:
                    role = "opener"
                else:
                    role = "middle"

        if role:
            name_role[name] = role

    # Build name -> bowl_type map (spinner/fast) from ESPN cache
    name_bowl_type = {}
    for name, pid in pids_to_fetch.items():
        entry = cache.get(pid, {})
        if isinstance(entry, dict) and entry.get("bowl_type"):
            name_bowl_type[name] = entry["bowl_type"]

    # Build name -> bat_pos map (opener/middle) from batting positions
    name_bat_pos = {}
    for name, pid in pids_to_fetch.items():
        bp = batpos_cache.get(pid)
        if bp:
            name_bat_pos[name] = "opener" if bp <= 2 else "middle"

    from collections import Counter
    dist = Counter(name_role.values())
    print(f"  Role distribution: {dict(dist.most_common())}")
    print(f"  Assigned: {len(name_role)}, unassigned: {len(pids_to_fetch) - len(name_role)}\n", flush=True)

    # Patch JSONs
    print("=== Patching JSON files ===", flush=True)
    for jpath in ["docs/rankings.json", "docs/odi_rankings.json", "docs/t20i_rankings.json", "docs/ipl_rankings.json"]:
        if not Path(jpath).exists():
            continue
        with open(jpath) as f:
            data = json.load(f)

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
