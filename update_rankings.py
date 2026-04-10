#!/usr/bin/env python3
"""
GOAT Cricket Rankings — Daily Update Script

Scrapes ESPN Cricinfo for Test cricket data, computes BEI/BoEI/AEI
excellence indices, and writes site/rankings.json for the static website.

Usage:
    python update_rankings.py          # Uses existing cache, recomputes indices
    python update_rankings.py --scrape # Also scrapes for new/updated players
"""

import json
import pickle
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from bs4 import BeautifulSoup

# ─── Constants ───────────────────────────────────────────────────────────────

BOWL_K = 1000
MIN_STINT_BAT_INN = 10
MIN_STINT_BOWL_INN = 10
MIN_MATCHES = 20
LOI_MIN_MATCHES = 50
STINT_SIZE = 10
TOP_N = 100
RATING_BASE = 500   # median player = 500
RATING_K = 250      # sqrt-compressed: 1000+=GOAT, 900+=elite, 800+=great
LONGEVITY_EXP = 0.30  # unified innings^exp across all formats
MIN_AR_RATING = 250  # min rating in both bat & bowl to qualify as allrounder (Tests)
LOI_MIN_AR_RATING = 250  # same threshold; ranking uses geometric mean to handle balance
LOI_MIN_MATCHES_T20 = 30  # T20I has shorter careers
IPL_MIN_MATCHES = 50  # IPL has more games per season; 50 ≈ 3+ seasons
TEST_MIN_BOWL_INNS = 20  # min bowling innings to qualify for Test bowling ranking
TEST_SR_EXP = 0.20  # mild strike-rate factor: (baseline_sr / sr) ^ 0.2

FULL_MEMBERS = {"AUS", "BAN", "ENG", "IND", "IRE", "NZ", "PAK", "SA", "SL", "WI", "ZIM", "AFG"}

def is_full_member(country: str) -> bool:
    return any(c in FULL_MEMBERS for c in country.split("/"))

CACHE_DIR = Path(__file__).parent / "cricket_cache"
CACHE_DIR.mkdir(exist_ok=True)
SITE_DIR = Path(__file__).parent / "docs"
SITE_DIR.mkdir(exist_ok=True)

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

BAT_AGG_PATH = CACHE_DIR / "batting_aggregate.pkl"
BOWL_AGG_PATH = CACHE_DIR / "bowling_aggregate.pkl"
ALLROUND_CACHE_PATH = CACHE_DIR / "allround_cache.pkl"
INNINGS_CACHE_PATH = CACHE_DIR / "innings_cache.pkl"
ERA_CACHE_PATH = CACHE_DIR / "era_cache.pkl"

# ODI-specific cache paths
ODI_BAT_AGG_PATH = CACHE_DIR / "odi_bat_agg.pkl"
ODI_BOWL_AGG_PATH = CACHE_DIR / "odi_bowl_agg.pkl"
ODI_BAT_CUM_CACHE_PATH = CACHE_DIR / "odi_bat_cum_cache.pkl"
ODI_BOWL_CUM_CACHE_PATH = CACHE_DIR / "odi_bowl_cum_cache.pkl"
ODI_ERA_CACHE_PATH = CACHE_DIR / "odi_era_cache.pkl"

T20I_BAT_AGG_PATH = CACHE_DIR / "t20i_bat_agg.pkl"
T20I_BOWL_AGG_PATH = CACHE_DIR / "t20i_bowl_agg.pkl"
T20I_BAT_CUM_CACHE_PATH = CACHE_DIR / "t20i_bat_cum_cache.pkl"
T20I_BOWL_CUM_CACHE_PATH = CACHE_DIR / "t20i_bowl_cum_cache.pkl"
T20I_ERA_CACHE_PATH = CACHE_DIR / "t20i_era_cache.pkl"

IPL_BAT_AGG_PATH = CACHE_DIR / "ipl_bat_agg.pkl"
IPL_BOWL_AGG_PATH = CACHE_DIR / "ipl_bowl_agg.pkl"
IPL_BAT_CUM_CACHE_PATH = CACHE_DIR / "ipl_bat_cum_cache.pkl"
IPL_BOWL_CUM_CACHE_PATH = CACHE_DIR / "ipl_bowl_cum_cache.pkl"
IPL_ERA_CACHE_PATH = CACHE_DIR / "ipl_era_cache.pkl"
IPL_TEAM_MAP_PATH = CACHE_DIR / "ipl_team_map.pkl"



# Global match-level stats caches (keyed by start_date)
TEST_GLOBAL_MATCH_CACHE = CACHE_DIR / "test_global_match_stats.pkl"
ODI_GLOBAL_MATCH_CACHE = CACHE_DIR / "odi_global_match_stats.pkl"
T20I_GLOBAL_MATCH_CACHE = CACHE_DIR / "t20i_global_match_stats.pkl"
IPL_GLOBAL_MATCH_CACHE = CACHE_DIR / "ipl_global_match_stats.pkl"

# Cricinfo stats tables use abbreviated names (initials + surname) which can
# be misleading for players whose names don't follow Western conventions.
# Map player_id -> correct display name for known cases.
NAME_CORRECTIONS = {
    1108375: "Varun Chakravarthy",
}

# ─── Scraping ────────────────────────────────────────────────────────────────


def _parse_player_country(name_str: str) -> tuple[str, str]:
    m = re.match(r"^(.+?)\(([^)]+)\)$", name_str.strip())
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return name_str.strip(), ""


def scrape_statsguru_aggregate(
    stat_type: str = "batting", min_matches: int = 20, page_size: int = 200,
    cricket_class: int = 1, extra_params: str = "",
) -> pd.DataFrame:
    base = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class={cricket_class}{extra_params};template=results;type={stat_type};"
        f"qualmin1={min_matches};qualval1=matches;size={page_size}"
    )
    all_rows = []
    page = 1

    while True:
        url = f"{base};page={page}"
        print(f"  Fetching {stat_type} page {page}...")
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
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
            row_data = {}
            for j, (col_name, td) in enumerate(zip(cols, cells)):
                if col_name == "Player":
                    link = td.find("a")
                    raw_name = td.get_text(strip=True)
                    name, country = _parse_player_country(raw_name)
                    row_data["player_name"] = name
                    row_data["country"] = country
                    if link and link.get("href"):
                        m = re.search(r"/player/(\d+)\.html", link["href"])
                        if m:
                            row_data["player_id"] = int(m.group(1))
                else:
                    row_data[col_name] = td.get_text(strip=True)
            if "player_id" in row_data:
                page_rows.append(row_data)

        if not page_rows:
            break
        all_rows.extend(page_rows)
        print(f"    -> {len(page_rows)} players ({len(all_rows)} total)")

        has_next = any(a.get_text(strip=True) == "Next" for a in soup.find_all("a"))
        if has_next:
            page += 1
            time.sleep(0.5)
        else:
            break

    df = pd.DataFrame(all_rows)
    if "player_id" in df.columns and "player_name" in df.columns:
        df["player_name"] = df.apply(
            lambda r: NAME_CORRECTIONS.get(int(r["player_id"]), r["player_name"]), axis=1
        )
    return df


def clean_allround_df(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for col in ["Mat", "Runs", "Bat Av", "100", "Wkts", "Bowl Av", "5", "Ct", "St", "Ave Diff"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def scrape_player_allround(player_id: int) -> pd.DataFrame | None:
    url = (
        f"https://stats.espncricinfo.com/ci/engine/player/{player_id}.html?"
        f"class=1;template=results;type=allround;view=cumulative"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")

        tables = soup.select("table.engineTable")
        if not tables:
            return None

        cum_table = max(tables, key=lambda t: len(t.find_all("tr")))
        all_rows = cum_table.find_all("tr")
        if len(all_rows) < 2:
            return None

        header_tr = cum_table.select_one("tr.headlinks") or all_rows[0]
        cols = [c.get_text(strip=True) for c in header_tr.find_all(["th", "td"])]

        seen: dict[str, int] = {}
        clean_cols = []
        for c in cols:
            if c == "":
                idx = seen.get("", 0)
                clean_cols.append(f"_blank_{idx}")
                seen[""] = idx + 1
            else:
                clean_cols.append(c)

        data_rows = []
        for tr in all_rows:
            if tr is header_tr:
                continue
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) == len(clean_cols):
                data_rows.append(cells)

        if not data_rows:
            return None

        df = pd.DataFrame(data_rows, columns=clean_cols)
        df = df.loc[:, ~df.columns.str.startswith("_blank_")]

        player_name = "Unknown"
        for a in soup.find_all("a"):
            text = a.get_text(strip=True)
            if text.startswith("Statistics / Statsguru /"):
                parts = text.split("/")
                if len(parts) >= 3:
                    player_name = parts[2].strip()
                break

        df.attrs["player_name"] = player_name
        return df
    except Exception:
        return None


def _scrape_cumulative_innings(player_id: int, stat_type: str) -> dict[int, int] | None:
    """Scrape cumulative innings from batting or bowling view. Returns {match_num: cumulative_innings}."""
    url = (
        f"https://stats.espncricinfo.com/ci/engine/player/{player_id}.html?"
        f"class=1;template=results;type={stat_type};view=cumulative"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")
        tables = soup.select("table.engineTable")
        if not tables:
            return None
        data_table = max(tables, key=lambda t: len(t.find_all("tr")))
        all_rows = data_table.find_all("tr")
        if len(all_rows) < 2:
            return None
        header_tr = data_table.select_one("tr.headlinks") or all_rows[0]
        cols = [c.get_text(strip=True) for c in header_tr.find_all(["th", "td"])]
        if "Mat" not in cols or "Inns" not in cols:
            return None
        mat_idx = cols.index("Mat")
        inn_idx = cols.index("Inns")
        result = {}
        for tr in all_rows:
            if tr is header_tr:
                continue
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) <= max(mat_idx, inn_idx):
                continue
            try:
                mat = int(cells[mat_idx])
                inn = int(cells[inn_idx])
                result[mat] = inn
            except (ValueError, TypeError):
                continue
        return result if result else None
    except Exception:
        return None


def scrape_player_innings(player_id: int) -> dict:
    """Returns {'bat': {mat: cum_inn}, 'bowl': {mat: cum_inn}} for a player."""
    bat = _scrape_cumulative_innings(player_id, "batting") or {}
    time.sleep(0.2)
    bowl = _scrape_cumulative_innings(player_id, "bowling") or {}
    return {"bat": bat, "bowl": bowl}


# ─── Caching ─────────────────────────────────────────────────────────────────


def load_allround_cache() -> dict:
    if ALLROUND_CACHE_PATH.exists():
        with open(ALLROUND_CACHE_PATH, "rb") as f:
            return pickle.load(f)
    return {}


def save_allround_cache(cache: dict):
    with open(ALLROUND_CACHE_PATH, "wb") as f:
        pickle.dump(cache, f)


def load_innings_cache() -> dict:
    if INNINGS_CACHE_PATH.exists():
        with open(INNINGS_CACHE_PATH, "rb") as f:
            return pickle.load(f)
    return {}


def save_innings_cache(cache: dict):
    with open(INNINGS_CACHE_PATH, "wb") as f:
        pickle.dump(cache, f)


def load_era_cache() -> dict:
    if ERA_CACHE_PATH.exists():
        with open(ERA_CACHE_PATH, "rb") as f:
            return pickle.load(f)
    return {}


def save_era_cache(cache: dict):
    with open(ERA_CACHE_PATH, "wb") as f:
        pickle.dump(cache, f)


def _scrape_era_aggregate(start_year: int, end_year: int) -> dict | None:
    """Scrape overall Test figures (Runs, Wkts, Ave) for a date range."""
    url = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class=1;spanmin1=01+Jan+{start_year};spanmax1=31+Dec+{end_year};"
        f"spanval1=span;template=results;type=aggregate"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")
        tables = soup.select("table.engineTable")
        for table in tables:
            rows = table.select("tr.data1")
            if not rows:
                continue
            cells = rows[0].find_all("td")
            headers = [th.get_text(strip=True) for th in table.select("tr th")]
            if "Runs" not in headers or "Wkts" not in headers:
                continue
            vals = [c.get_text(strip=True) for c in cells]
            row_dict = dict(zip(headers, vals))
            runs = int(row_dict["Runs"].replace(",", ""))
            wkts = int(row_dict["Wkts"].replace(",", ""))
            ave = float(row_dict["Ave"]) if row_dict.get("Ave", "-") != "-" else (runs / wkts if wkts else 0)
            return {"runs": runs, "wkts": wkts, "ave": round(ave, 2)}
    except Exception as e:
        print(f"    WARNING: Failed to scrape era {start_year}-{end_year}: {e}")
    return None


def scrape_era_averages(
    spans: set[tuple[int, int]], delay: float = 0.3
) -> dict[tuple[int, int], dict]:
    """Scrape era averages for all unique career spans, with caching."""
    cache = load_era_cache()
    current_year = datetime.now().year
    to_scrape = []
    for span in spans:
        if span not in cache:
            to_scrape.append(span)
        elif span[1] >= current_year:
            to_scrape.append(span)

    if not to_scrape:
        print(f"  Era cache complete: {len(cache)} spans")
        return cache

    print(f"  Scraping era averages for {len(to_scrape)} spans...")
    for i, (sy, ey) in enumerate(sorted(to_scrape)):
        result = _scrape_era_aggregate(sy, ey)
        if result:
            cache[(sy, ey)] = result
        if i > 0 and i % 50 == 0:
            save_era_cache(cache)
            print(f"    {i}/{len(to_scrape)} done...")
        time.sleep(delay)

    save_era_cache(cache)
    print(f"  Era cache: {len(cache)} spans")
    return cache


def parse_span(span_str: str) -> tuple[int, int] | None:
    """Parse '1989-2013' into (1989, 2013)."""
    parts = span_str.strip().split("-")
    if len(parts) == 2:
        try:
            return int(parts[0]), int(parts[1])
        except ValueError:
            pass
    return None


def compute_all_time_avg(era_cache: dict) -> float:
    """Compute all-time Test average from the broadest span in cache, or default."""
    if not era_cache:
        return 31.91
    broadest = max(era_cache.keys(), key=lambda k: k[1] - k[0])
    return era_cache[broadest]["ave"]


# ─── Pitch Difficulty (global match-level stats) ─────────────────────────────


def _parse_agg_float(val: str) -> float:
    """Parse a float value from scraped text, returning 0.0 for '-' or empty."""
    val = val.strip().replace(",", "")
    if not val or val == "-":
        return 0.0
    return float(val)


def _parse_agg_int(val: str) -> int:
    """Parse an aggregate integer value, returning 0 for '-' or empty."""
    val = val.strip().replace(",", "")
    if not val or val == "-":
        return 0
    return int(val)


def scrape_global_match_stats(
    cricket_class: int = 1,
    extra_params: str = "",
    cache_path: Path = TEST_GLOBAL_MATCH_CACHE,
    force: bool = False,
    delay: float = 0.5,
) -> dict[str, list[dict]]:
    """Scrape all match-level aggregate stats from Statsguru view=match.

    Returns dict keyed by start_date_str -> list of match dicts, each with
    {teams, ground, ave, rpo, runs, wkts}.
    """
    if cache_path.exists() and not force:
        with open(cache_path, "rb") as f:
            cached = pickle.load(f)
        print(f"  Global match stats loaded from cache: {sum(len(v) for v in cached.values())} matches")
        return cached

    print(f"  Scraping global match stats (class={cricket_class})...")
    result: dict[str, list[dict]] = {}
    page = 1
    total = 0

    while True:
        url = (
            f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
            f"class={cricket_class}{extra_params};template=results;type=aggregate;"
            f"view=match;size=200;page={page}"
        )
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "lxml")
        except Exception as e:
            print(f"    WARNING: Failed page {page}: {e}")
            break

        page_count = 0
        for table in soup.select("table.engineTable"):
            rows = table.select("tr.data1")
            hdrs = [th.get_text(strip=True) for th in table.select("tr th")]
            if not rows or "Ave" not in hdrs:
                continue

            for row in rows:
                cells = row.find_all("td")
                vals = [c.get_text(strip=True) for c in cells]
                row_dict = dict(zip(hdrs, vals))

                start_date = row_dict.get("Start Date", "").strip()
                teams = row_dict.get("Match", "").strip()
                ground = row_dict.get("Ground", "").strip()
                ave = _parse_agg_float(row_dict.get("Ave", "0"))
                rpo = _parse_agg_float(row_dict.get("RPO", "0"))
                runs = _parse_agg_int(row_dict.get("Runs", "0"))
                wkts = _parse_agg_int(row_dict.get("Wkts", "0"))

                if not start_date:
                    continue

                entry = {
                    "teams": teams, "ground": ground,
                    "ave": round(ave, 2), "rpo": round(rpo, 2),
                    "runs": runs, "wkts": wkts,
                }
                result.setdefault(start_date, []).append(entry)
                page_count += 1

        total += page_count
        if page_count == 0:
            break
        print(f"    Page {page}: {page_count} matches (total {total})")
        page += 1
        time.sleep(delay)

    with open(cache_path, "wb") as f:
        pickle.dump(result, f)
    print(f"  Global match stats: {total} matches across {len(result)} dates")
    return result


def _scrape_all_time_aggregate(cricket_class: int = 1, extra_params: str = "") -> dict:
    """Scrape all-time aggregate stats (Runs, Wkts, Ave, RPO) for a format."""
    url = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class={cricket_class}{extra_params};template=results;type=aggregate"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")
        for table in soup.select("table.engineTable"):
            rows = table.select("tr.data1")
            if not rows:
                continue
            cells = rows[0].find_all("td")
            hdrs = [th.get_text(strip=True) for th in table.select("tr th")]
            if "Runs" not in hdrs or "Wkts" not in hdrs:
                continue
            vals = [c.get_text(strip=True) for c in cells]
            row_dict = dict(zip(hdrs, vals))
            runs = _parse_agg_int(row_dict["Runs"])
            wkts = _parse_agg_int(row_dict["Wkts"])
            balls = _parse_agg_int(row_dict.get("Balls", "0"))
            ave = float(row_dict["Ave"]) if row_dict.get("Ave", "-") != "-" else (runs / wkts if wkts else 0)
            rpo = float(row_dict["RPO"]) if row_dict.get("RPO", "-") != "-" else (6 * runs / balls if balls else 0)
            return {"runs": runs, "wkts": wkts, "ave": round(ave, 2), "rpo": round(rpo, 2)}
    except Exception as e:
        print(f"    WARNING: Failed to scrape all-time aggregate: {e}")
    return {"runs": 0, "wkts": 0, "ave": 31.91, "rpo": 4.7}


def _lookup_match_stats(
    global_match_stats: dict[str, list[dict]],
    start_date: str,
    opposition: str,
) -> dict | None:
    """Find a match's aggregate stats by start date and opposition name."""
    matches = global_match_stats.get(start_date)
    if not matches:
        return None

    opp_clean = opposition.lstrip("v").strip().lower()
    if len(matches) == 1:
        return matches[0]

    for m in matches:
        if opp_clean in m["teams"].lower():
            return m

    return None


def compute_player_pitch_factors(
    df: pd.DataFrame,
    global_match_stats: dict[str, list[dict]],
    all_time_avg: float,
    all_time_rpo: float | None = None,
) -> dict:
    """Compute pitch difficulty factors for a player from their match history.

    The player's own runs and wickets are subtracted from each match total
    so a dominant individual performance doesn't inflate the match average
    and then penalize the same player.

    Returns {match_avg, match_rpo, bat_pitch_factor, bowl_pitch_factor}.
    """
    if "Opposition" not in df.columns or "Start Date" not in df.columns:
        return {"match_avg": all_time_avg, "match_rpo": all_time_rpo or 0,
                "bat_pitch_factor": 1.0, "bowl_pitch_factor": 1.0}

    df_work = df.copy()
    if "Runs" in df_work.columns:
        df_work["_Runs"] = df_work["Runs"].apply(lambda v: _safe_float(v, 0))
        player_runs = df_work["_Runs"].diff().fillna(df_work["_Runs"])
    else:
        player_runs = pd.Series(0.0, index=df_work.index)
    if "Wkts" in df_work.columns:
        df_work["_Wkts"] = df_work["Wkts"].apply(lambda v: _safe_float(v, 0))
        player_wkts = df_work["_Wkts"].diff().fillna(df_work["_Wkts"])
    else:
        player_wkts = pd.Series(0.0, index=df_work.index)

    total_runs = 0
    total_wkts = 0
    matched = 0

    for i, (_, row) in enumerate(df_work.iterrows()):
        opp = str(row.get("Opposition", ""))
        date = str(row.get("Start Date", ""))
        if not opp or not date:
            continue

        m = _lookup_match_stats(global_match_stats, date, opp)
        if m and m["wkts"] > 0:
            mr = m["runs"] - player_runs.iloc[i]
            mw = m["wkts"] - player_wkts.iloc[i]
            if mw > 0:
                total_runs += mr
                total_wkts += mw
                matched += 1

    if total_wkts == 0 or matched < 3:
        return {"match_avg": all_time_avg, "match_rpo": all_time_rpo or 0,
                "bat_pitch_factor": 1.0, "bowl_pitch_factor": 1.0}

    match_avg = round(total_runs / total_wkts, 2)
    bat_pitch_factor = round(all_time_avg / match_avg, 4) if match_avg > 0 else 1.0
    bowl_pitch_factor = round(match_avg / all_time_avg, 4) if all_time_avg > 0 else 1.0

    match_rpo = 0.0
    if all_time_rpo:
        rpo_runs = 0
        rpo_count = 0
        for _, row in df_work.iterrows():
            opp = str(row.get("Opposition", ""))
            date = str(row.get("Start Date", ""))
            m = _lookup_match_stats(global_match_stats, date, opp)
            if m and m["rpo"] > 0:
                rpo_runs += m["rpo"]
                rpo_count += 1
        if rpo_count > 0:
            match_rpo = round(rpo_runs / rpo_count, 2)
            bat_sr_factor = all_time_rpo / match_rpo if match_rpo > 0 else 1.0
            bat_pitch_factor = round(bat_pitch_factor * bat_sr_factor, 4)
            bowl_rpo_factor = match_rpo / all_time_rpo if all_time_rpo > 0 else 1.0
            bowl_pitch_factor = round(bowl_pitch_factor * bowl_rpo_factor, 4)

    return {
        "match_avg": match_avg,
        "match_rpo": match_rpo,
        "bat_pitch_factor": bat_pitch_factor,
        "bowl_pitch_factor": bowl_pitch_factor,
        "matched_pct": round(100 * matched / len(df), 1) if len(df) > 0 else 0,
    }


def load_or_scrape_aggregates(force_scrape: bool = False):
    for p in [BAT_AGG_PATH, BOWL_AGG_PATH]:
        if p.exists():
            existing = pd.read_pickle(p)
            if "country" not in existing.columns:
                p.unlink()

    if BAT_AGG_PATH.exists() and not force_scrape:
        bat_agg = pd.read_pickle(BAT_AGG_PATH)
        print(f"Loaded cached batting aggregate: {len(bat_agg)} players")
    else:
        print("Scraping batting aggregate pages...")
        bat_agg = scrape_statsguru_aggregate("batting", min_matches=MIN_MATCHES)
        bat_agg.to_pickle(BAT_AGG_PATH)
        print(f"Saved {len(bat_agg)} batting players")

    if BOWL_AGG_PATH.exists() and not force_scrape:
        bowl_agg = pd.read_pickle(BOWL_AGG_PATH)
        print(f"Loaded cached bowling aggregate: {len(bowl_agg)} players")
    else:
        print("Scraping bowling aggregate pages...")
        bowl_agg = scrape_statsguru_aggregate("bowling", min_matches=MIN_MATCHES)
        bowl_agg.to_pickle(BOWL_AGG_PATH)
        print(f"Saved {len(bowl_agg)} bowling players")

    return bat_agg, bowl_agg


def scrape_all_players(player_ids: list[int], delay: float = 0.3) -> dict:
    cache = load_allround_cache()
    to_scrape = [pid for pid in player_ids if pid not in cache]

    print(f"Cache has {len(cache)} players. Need to scrape {len(to_scrape)} more.")
    if not to_scrape:
        print("All players already cached!")
        return cache

    failed = []
    for i, pid in enumerate(to_scrape, 1):
        raw = scrape_player_allround(pid)
        if raw is not None:
            df = clean_allround_df(raw)
            df.attrs["player_name"] = raw.attrs.get("player_name", "Unknown")
            cache[pid] = df
        else:
            failed.append(pid)

        if i % 50 == 0 or i == len(to_scrape):
            save_allround_cache(cache)
            print(f"  Progress: {i}/{len(to_scrape)}, {len(failed)} failed")
        time.sleep(delay)

    save_allround_cache(cache)
    print(f"Done! Cache: {len(cache)} players. {len(failed)} failures.")
    return cache


def scrape_all_innings(player_ids: list[int], delay: float = 0.3) -> dict:
    cache = load_innings_cache()
    to_scrape = [pid for pid in player_ids if pid not in cache]

    print(f"Innings cache has {len(cache)} players. Need to scrape {len(to_scrape)} more.")
    if not to_scrape:
        print("All innings already cached!")
        return cache

    failed = []
    for i, pid in enumerate(to_scrape, 1):
        data = scrape_player_innings(pid)
        if data["bat"] or data["bowl"]:
            cache[pid] = data
        else:
            failed.append(pid)

        if i % 50 == 0 or i == len(to_scrape):
            save_innings_cache(cache)
            print(f"  Innings progress: {i}/{len(to_scrape)}, {len(failed)} failed")
        time.sleep(delay)

    save_innings_cache(cache)
    print(f"Innings done! Cache: {len(cache)} players. {len(failed)} failures.")
    return cache


# ─── Computation ─────────────────────────────────────────────────────────────


def compute_stints(
    df: pd.DataFrame,
    innings_data: dict | None = None,
    stint_size: int = STINT_SIZE,
) -> list[dict]:
    df = df.copy()
    df["_bat_dism"] = np.where(df["Bat Av"] > 0, df["Runs"] / df["Bat Av"], 0)
    df["_bowl_runs"] = np.where(df["Wkts"] > 0, df["Bowl Av"].fillna(0) * df["Wkts"], 0)

    bat_inn_map = innings_data.get("bat", {}) if innings_data else {}
    bowl_inn_map = innings_data.get("bowl", {}) if innings_data else {}

    def _get_cum_inn(inn_map, mat_num):
        """Look up cumulative innings for a match number."""
        if not inn_map:
            return None
        m = int(mat_num)
        if m in inn_map:
            return inn_map[m]
        closest = min(inn_map.keys(), key=lambda k: abs(k - m), default=None)
        if closest is not None and abs(closest - m) <= 1:
            return inn_map[closest]
        return None

    stints = []
    n = len(df)
    i = 0

    while i < n:
        end_idx = min(i + stint_size - 1, n - 1)
        remaining_after = n - (end_idx + 1)
        if 0 < remaining_after < stint_size:
            end_idx = n - 1

        if i == 0:
            p_runs, p_dism, p_wkts, p_br = 0, 0, 0, 0
            p_bat_inn, p_bowl_inn = 0, 0
        else:
            p = df.iloc[i - 1]
            p_runs, p_dism, p_wkts, p_br = (
                p["Runs"], p["_bat_dism"], p["Wkts"], p["_bowl_runs"]
            )
            p_mat = int(p["Mat"])
            p_bat_inn = _get_cum_inn(bat_inn_map, p_mat) or 0
            p_bowl_inn = _get_cum_inn(bowl_inn_map, p_mat) or 0

        c = df.iloc[end_idx]
        matches = end_idx - i + 1
        s_runs = c["Runs"] - p_runs
        s_dism = c["_bat_dism"] - p_dism
        s_wkts = c["Wkts"] - p_wkts
        s_br = c["_bowl_runs"] - p_br

        c_mat = int(c["Mat"])
        c_bat_inn = _get_cum_inn(bat_inn_map, c_mat)
        c_bowl_inn = _get_cum_inn(bowl_inn_map, c_mat)

        s_bat_inn = (c_bat_inn - p_bat_inn) if c_bat_inn is not None else None
        s_bowl_inn = (c_bowl_inn - p_bowl_inn) if c_bowl_inn is not None else None

        bat_qualifies = s_bat_inn >= MIN_STINT_BAT_INN if s_bat_inn is not None else s_dism >= MIN_STINT_BAT_INN
        bowl_qualifies = s_bowl_inn >= MIN_STINT_BOWL_INN if s_bowl_inn is not None else s_wkts >= MIN_STINT_BOWL_INN

        bat_avg = float(s_runs / s_dism) if bat_qualifies and s_dism > 0 else None
        bowl_avg = float(s_br / s_wkts) if bowl_qualifies and s_wkts > 0 else None
        bowl_score = (BOWL_K / bowl_avg) if bowl_avg and bowl_avg > 0 else None
        wpm = float(s_wkts / matches) if bowl_qualifies and s_wkts > 0 else None

        stints.append({
            "label": f"{int(df.iloc[i]['Mat'])}\u2013{int(c['Mat'])}",
            "matches": matches,
            "bat_avg": round(bat_avg, 2) if bat_avg is not None else None,
            "bowl_avg": round(bowl_avg, 2) if bowl_avg is not None else None,
            "bowl_score": round(bowl_score, 2) if bowl_score is not None else None,
            "wpm": round(wpm, 2) if wpm is not None else None,
        })
        i = end_idx + 1

    return stints


def compute_test_career_indices(
    bat_inns: int, career_bat_avg: float, career_rpi: float,
    bowl_inns: int, career_bowl_avg: float, career_wpi: float,
    career_bowl_sr: float,
    boei_scale: float, baseline_wpi: float = 1.46, baseline_sr: float = 79.9,
) -> dict:
    import math as _math
    bat_metric = _math.sqrt(career_bat_avg * career_rpi) if career_bat_avg > 0 and career_rpi > 0 else 0.0
    bei = bat_metric * (bat_inns ** LONGEVITY_EXP) if bat_inns > 0 else 0.0
    boei = 0.0
    if bowl_inns >= TEST_MIN_BOWL_INNS and career_bowl_avg > 0 and career_wpi > 0 and baseline_wpi > 0:
        sr_factor = (baseline_sr / career_bowl_sr) ** TEST_SR_EXP if career_bowl_sr > 0 and baseline_sr > 0 else 1.0
        boei = (BOWL_K / career_bowl_avg) * _math.sqrt(career_wpi / baseline_wpi) * sr_factor * (bowl_inns ** LONGEVITY_EXP) * boei_scale
    return {"BEI": round(bei, 2), "BoEI": round(boei, 2), "AEI": round(bei + boei, 2)}


def compute_test_baseline_wpi(bowl_agg: pd.DataFrame, min_matches: int = MIN_MATCHES) -> float:
    wpis = []
    for _, r in bowl_agg.iterrows():
        mat = int(_safe_float(r["Mat"]))
        wkts = int(_safe_float(r["Wkts"], 0))
        inns = int(_safe_float(r["Inns"], 0))
        if mat >= min_matches and inns >= TEST_MIN_BOWL_INNS and inns > 0:
            wpis.append(wkts / inns)
    return float(np.mean(wpis)) if wpis else 1.46


def compute_test_baseline_sr(bowl_agg: pd.DataFrame, min_matches: int = MIN_MATCHES) -> float:
    srs = []
    for _, r in bowl_agg.iterrows():
        mat = int(_safe_float(r["Mat"]))
        inns = int(_safe_float(r["Inns"], 0))
        sr = _safe_float(r.get("SR", 0), 0)
        if mat >= min_matches and inns >= TEST_MIN_BOWL_INNS and sr > 0:
            srs.append(sr)
    return float(np.mean(srs)) if srs else 79.9


def compute_test_boei_scale(
    bat_agg: pd.DataFrame, bowl_agg: pd.DataFrame,
    baseline_wpi: float, baseline_sr: float, min_matches: int = MIN_MATCHES,
) -> float:
    import math as _math
    bat_vals = []
    for _, r in bat_agg.iterrows():
        avg = _safe_float(r["Ave"])
        inns = int(_safe_float(r["Inns"]))
        mat = int(_safe_float(r["Mat"]))
        runs = int(_safe_float(r.get("Runs", 0), 0))
        rpi = runs / inns if inns > 0 else 0
        if avg > 0 and rpi > 0 and inns > 0 and mat >= min_matches:
            bat_vals.append(_math.sqrt(avg * rpi) * (inns ** LONGEVITY_EXP))

    bowl_vals = []
    for _, r in bowl_agg.iterrows():
        avg = _safe_float(r["Ave"])
        inns = int(_safe_float(r["Inns"], 0))
        mat = int(_safe_float(r["Mat"]))
        wkts = int(_safe_float(r["Wkts"], 0))
        sr = _safe_float(r.get("SR", 0), 0)
        if avg > 0 and inns >= TEST_MIN_BOWL_INNS and mat >= min_matches and inns > 0:
            wpi = wkts / inns
            sr_factor = (baseline_sr / sr) ** TEST_SR_EXP if sr > 0 and baseline_sr > 0 else 1.0
            if wpi > 0 and baseline_wpi > 0:
                bowl_vals.append((BOWL_K / avg) * _math.sqrt(wpi / baseline_wpi) * sr_factor * (inns ** LONGEVITY_EXP))

    if not bowl_vals or not bat_vals:
        return 1.0
    return float(np.mean(bat_vals)) / float(np.mean(bowl_vals))


def compute_all_players(
    cache: dict,
    innings_cache: dict,
    bat_agg: pd.DataFrame,
    bowl_agg: pd.DataFrame,
    player_info: pd.DataFrame,
    boei_scale: float,
    baseline_wpi: float = 1.46,
    baseline_sr: float = 79.9,
    global_match_stats: dict | None = None,
    all_time_avg: float = 31.91,
):
    bat_lookup = {}
    for _, r in bat_agg.iterrows():
        pid = int(r["player_id"])
        inns = int(_safe_float(r["Inns"]))
        runs = int(_safe_float(r.get("Runs", 0), 0))
        bat_lookup[pid] = {
            "avg": _safe_float(r["Ave"]),
            "inns": inns,
            "mat": int(_safe_float(r["Mat"])),
            "rpi": runs / inns if inns > 0 else 0,
        }

    bowl_lookup = {}
    for _, r in bowl_agg.iterrows():
        pid = int(r["player_id"])
        wkts = int(_safe_float(r.get("Wkts", 0), 0))
        mat = int(_safe_float(r["Mat"]))
        b_inns = int(_safe_float(r["Inns"], 0))
        bowl_lookup[pid] = {
            "avg": _safe_float(r["Ave"]),
            "inns": b_inns,
            "mat": mat,
            "wkts": wkts,
            "wpi": wkts / b_inns if b_inns > 0 else 0,
            "sr": _safe_float(r.get("SR", 0), 0),
        }

    records = []
    for pid, df in cache.items():
        try:
            name = df.attrs.get("player_name", "Unknown")
            df_clean = df.dropna(subset=["Mat"])
            if len(df_clean) < 2:
                continue

            ba = bat_lookup.get(int(pid), {})
            bo = bowl_lookup.get(int(pid), {})
            bat_inns = ba.get("inns", 0)
            bat_avg = ba.get("avg", 0)
            bat_rpi = ba.get("rpi", 0)
            bowl_inns = bo.get("inns", 0)
            bowl_avg = bo.get("avg", 0)
            career_wpi = bo.get("wpi", 0)
            career_bowl_sr = bo.get("sr", 0)
            career_mat = ba.get("mat", 0)

            if career_mat < MIN_MATCHES:
                continue

            idx = compute_test_career_indices(
                bat_inns, bat_avg, bat_rpi, bowl_inns, bowl_avg, career_wpi,
                career_bowl_sr,
                boei_scale, baseline_wpi, baseline_sr,
            )

            pf = compute_player_pitch_factors(
                df_clean, global_match_stats or {}, all_time_avg
            )
            bei = round(idx["BEI"] * pf["bat_pitch_factor"], 2)
            boei = round(idx["BoEI"] * pf["bowl_pitch_factor"], 2)
            aei = round(bei + boei, 2)

            info_row = player_info[player_info["player_id"] == int(pid)]
            country = info_row["country"].values[0] if len(info_row) > 0 else ""

            inn_data = innings_cache.get(pid)
            stints = compute_stints(df_clean, inn_data)

            records.append({
                "player_id": int(pid),
                "player_name": name,
                "country": country,
                "BEI": bei,
                "BoEI": boei,
                "AEI": aei,
                "matches": career_mat,
                "stints": stints,
                "match_avg": pf["match_avg"],
                "bat_pitch_factor": pf["bat_pitch_factor"],
                "bowl_pitch_factor": pf["bowl_pitch_factor"],
                "career_bat_avg": round(bat_avg, 2) if bat_avg > 0 else None,
                "career_bowl_avg": round(bowl_avg, 2) if bowl_avg > 0 else None,
                "career_bowl_sr": round(career_bowl_sr, 1) if career_bowl_sr > 0 else None,
            })
        except Exception:
            continue

    records.sort(key=lambda r: r["AEI"], reverse=True)
    return records


# ─── LOI (Limited-Overs International) Functions ────────────────────────────


def overs_to_balls(overs_val) -> int:
    """Convert overs (e.g. 104.3 = 104 overs 3 balls) to total balls."""
    try:
        s = str(overs_val)
        parts = s.split(".")
        full = int(parts[0])
        extra = int(parts[1]) if len(parts) > 1 else 0
        return full * 6 + extra
    except (ValueError, TypeError):
        return 0


def _scrape_cumulative_full(
    player_id: int, stat_type: str, cricket_class: int = 2, extra_params: str = "",
) -> pd.DataFrame | None:
    """Scrape full cumulative data (batting or bowling view) for a player."""
    url = (
        f"https://stats.espncricinfo.com/ci/engine/player/{player_id}.html?"
        f"class={cricket_class}{extra_params};template=results;type={stat_type};view=cumulative"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")

        tables = soup.select("table.engineTable")
        if not tables:
            return None

        data_table = max(tables, key=lambda t: len(t.find_all("tr")))
        all_rows = data_table.find_all("tr")
        if len(all_rows) < 2:
            return None

        header_tr = data_table.select_one("tr.headlinks") or all_rows[0]
        cols = [c.get_text(strip=True) for c in header_tr.find_all(["th", "td"])]

        seen: dict[str, int] = {}
        clean_cols = []
        for c in cols:
            if c == "":
                idx = seen.get("", 0)
                clean_cols.append(f"_blank_{idx}")
                seen[""] = idx + 1
            else:
                clean_cols.append(c)

        data_rows = []
        for tr in all_rows:
            if tr is header_tr:
                continue
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) == len(clean_cols):
                data_rows.append(cells)

        if not data_rows:
            return None

        df = pd.DataFrame(data_rows, columns=clean_cols)
        df = df.loc[:, ~df.columns.str.startswith("_blank_")]

        player_name = "Unknown"
        for a in soup.find_all("a"):
            text = a.get_text(strip=True)
            if text.startswith("Statistics / Statsguru /"):
                parts = text.split("/")
                if len(parts) >= 3:
                    player_name = parts[2].strip()
                break

        df.attrs["player_name"] = player_name
        return df
    except Exception:
        return None


def _load_loi_cache(path: Path) -> dict:
    if path.exists():
        with open(path, "rb") as f:
            return pickle.load(f)
    return {}


def _save_loi_cache(cache: dict, path: Path):
    with open(path, "wb") as f:
        pickle.dump(cache, f)




def scrape_loi_all_players(
    player_ids: list[int],
    cricket_class: int = 2,
    bat_cache_path: Path = ODI_BAT_CUM_CACHE_PATH,
    bowl_cache_path: Path = ODI_BOWL_CUM_CACHE_PATH,
    delay: float = 0.3,
    extra_params: str = "",
) -> tuple[dict, dict]:
    """Scrape batting + bowling cumulative data for all LOI players."""
    bat_cache = _load_loi_cache(bat_cache_path)
    bowl_cache = _load_loi_cache(bowl_cache_path)

    to_scrape = [pid for pid in player_ids if pid not in bat_cache]
    print(f"  LOI cumulative cache: {len(bat_cache)} players. Need {len(to_scrape)} more.")

    if not to_scrape:
        return bat_cache, bowl_cache

    failed = []
    for i, pid in enumerate(to_scrape, 1):
        bat_df = _scrape_cumulative_full(pid, "batting", cricket_class, extra_params)
        time.sleep(0.15)
        bowl_df = _scrape_cumulative_full(pid, "bowling", cricket_class, extra_params)

        if bat_df is not None:
            bat_cache[pid] = bat_df
        else:
            failed.append(pid)
        if bowl_df is not None:
            bowl_cache[pid] = bowl_df

        if i % 50 == 0 or i == len(to_scrape):
            _save_loi_cache(bat_cache, bat_cache_path)
            _save_loi_cache(bowl_cache, bowl_cache_path)
            print(f"    LOI progress: {i}/{len(to_scrape)}, {len(failed)} failed")
        time.sleep(delay)

    _save_loi_cache(bat_cache, bat_cache_path)
    _save_loi_cache(bowl_cache, bowl_cache_path)
    print(f"  LOI done! {len(bat_cache)} bat, {len(bowl_cache)} bowl cached. {len(failed)} failures.")
    return bat_cache, bowl_cache


def _prepare_bat_cum(df: pd.DataFrame) -> pd.DataFrame:
    """Clean batting cumulative DataFrame for stint calculation."""
    df = df.copy()
    for col in ["Mat", "Inns", "NO", "Runs", "BF"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["Mat"])
    df = df.sort_values("Mat").reset_index(drop=True)
    for col in ["Inns", "NO", "Runs", "BF"]:
        if col in df.columns:
            df[col] = df[col].ffill().fillna(0)
    return df


def _count_format_innings(cum_df: pd.DataFrame, col: str = "Inns") -> int:
    """Count format-specific innings from cumulative data by counting increments.
    Needed because the Inns column may show career-wide totals (e.g. IPL data
    includes all T20 innings in the running total)."""
    if col not in cum_df.columns or len(cum_df) == 0:
        return 0
    vals = cum_df[col].astype(float).values
    count = 1  # first match
    for i in range(1, len(vals)):
        if vals[i] > vals[i - 1]:
            count += 1
    return count


def _prepare_bowl_cum(df: pd.DataFrame) -> pd.DataFrame:
    """Clean bowling cumulative DataFrame for stint calculation."""
    df = df.copy()
    if "Overs" in df.columns:
        df["cum_balls"] = df["Overs"].apply(overs_to_balls)
    for col in ["Mat", "Inns", "Runs", "Wkts"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["Mat"])
    df = df.sort_values("Mat").reset_index(drop=True)
    for col in ["Runs", "Wkts", "Inns"]:
        if col in df.columns:
            df[col] = df[col].ffill().fillna(0)
    if "cum_balls" not in df.columns:
        df["cum_balls"] = 0
    df["cum_balls"] = df["cum_balls"].ffill().fillna(0).astype(int)
    return df


LOI_STINT_INNINGS = 20


def _innings_boundaries(cum_inns: pd.Series, stint_innings: int = LOI_STINT_INNINGS) -> list[tuple[int, int]]:
    """Split cumulative innings series into stint boundaries of N innings each.
    Returns list of (start_idx, end_idx) index pairs."""
    n = len(cum_inns)
    if n == 0:
        return []

    boundaries = []
    start_idx = 0
    start_inns = 0.0

    for idx in range(n):
        current_inns = float(cum_inns.iloc[idx])
        if current_inns - start_inns >= stint_innings:
            boundaries.append((start_idx, idx))
            start_idx = idx + 1
            start_inns = current_inns

    if start_idx < n:
        remaining = float(cum_inns.iloc[n - 1]) - start_inns
        if remaining < stint_innings and boundaries:
            prev_start, _ = boundaries.pop()
            boundaries.append((prev_start, n - 1))
        elif remaining > 0:
            boundaries.append((start_idx, n - 1))

    return boundaries


def compute_stints_loi(
    bat_df: pd.DataFrame,
    bowl_df: pd.DataFrame | None,
) -> tuple[list[dict], list[dict]]:
    """Compute batting and bowling stints for chart visualization only.
    bat_metric = avg * SR / 100 (simple product, no adjustments).
    """
    bat = _prepare_bat_cum(bat_df)
    if len(bat) < 2:
        return [], []

    # -- Batting stints (by batting innings) --
    bat_boundaries = _innings_boundaries(bat["Inns"])
    bat_stints = []
    for si, ei in bat_boundaries:
        c = bat.iloc[ei]
        if si == 0:
            s_runs, s_bf, s_inns, s_no = float(c["Runs"]), float(c["BF"]), float(c["Inns"]), float(c["NO"])
        else:
            p = bat.iloc[si - 1]
            s_runs = float(c["Runs"]) - float(p["Runs"])
            s_bf = float(c["BF"]) - float(p["BF"])
            s_inns = float(c["Inns"]) - float(p["Inns"])
            s_no = float(c["NO"]) - float(p["NO"])

        matches = ei - si + 1
        s_dismissals = s_inns - s_no
        bat_avg = float(s_runs / s_dismissals) if s_dismissals > 0 else None
        bat_sr = float(100 * s_runs / s_bf) if s_bf > 0 else None
        bat_metric = float(bat_avg * bat_sr / 100) if bat_avg is not None and bat_sr is not None else None

        bat_stints.append({
            "label": f"{int(bat.iloc[si]['Mat'])}\u2013{int(c['Mat'])}",
            "matches": matches,
            "innings": int(s_inns),
            "bat_avg": round(bat_avg, 2) if bat_avg is not None else None,
            "bat_sr": round(bat_sr, 2) if bat_sr is not None else None,
            "bat_metric": round(bat_metric, 2) if bat_metric is not None else None,
        })

    # -- Bowling stints (by bowling innings) --
    bowl_stints = []
    if bowl_df is not None and len(bowl_df) > 0:
        bowl = _prepare_bowl_cum(bowl_df)
        if len(bowl) > 0 and float(bowl.iloc[-1]["Inns"]) >= LOI_STINT_INNINGS:
            bowl_boundaries = _innings_boundaries(bowl["Inns"])
            for si, ei in bowl_boundaries:
                c = bowl.iloc[ei]
                if si == 0:
                    s_wkts = float(c["Wkts"])
                    s_bowl_runs = float(c["Runs"])
                    s_balls = int(c["cum_balls"])
                    s_inns = float(c["Inns"])
                else:
                    p = bowl.iloc[si - 1]
                    s_wkts = float(c["Wkts"]) - float(p["Wkts"])
                    s_bowl_runs = float(c["Runs"]) - float(p["Runs"])
                    s_balls = int(c["cum_balls"]) - int(p["cum_balls"])
                    s_inns = float(c["Inns"]) - float(p["Inns"])

                matches = ei - si + 1
                bowl_avg = float(s_bowl_runs / s_wkts) if s_wkts > 0 else None
                econ = float(6 * s_bowl_runs / s_balls) if s_balls > 0 else None
                bowl_metric = (BOWL_K / (bowl_avg * (econ / 6))) if bowl_avg and econ and bowl_avg > 0 and econ > 0 else None
                wpm = float(s_wkts / matches) if s_wkts > 0 else None

                bowl_stints.append({
                    "label": f"{int(bowl.iloc[si]['Mat'])}\u2013{int(c['Mat'])}",
                    "matches": matches,
                    "innings": int(s_inns),
                    "bowl_avg": round(bowl_avg, 2) if bowl_avg is not None else None,
                    "econ": round(econ, 2) if econ is not None else None,
                    "bowl_metric": round(bowl_metric, 2) if bowl_metric is not None else None,
                    "wpm": round(wpm, 2) if wpm is not None else None,
                })

    return bat_stints, bowl_stints


def compute_loi_career_indices(
    bat_inns: int, bat_avg: float, bat_sr: float,
    bowl_inns: int = 0, bowl_avg: float = 0, bowl_econ: float = 0,
    boei_scale: float = 1.0,
) -> dict:
    """Career-formula BEI/BoEI/AEI for LOI formats using aggregate stats.
    BEI  = avg * SR/100 * bat_innings^exp
    BoEI = BOWL_K/(bowl_avg * econ/6) * bowl_innings^exp * boei_scale
    """
    bei = bat_avg * bat_sr / 100 * (bat_inns ** LONGEVITY_EXP) if bat_inns > 0 and bat_avg > 0 and bat_sr > 0 else 0

    boei = 0.0
    if bowl_inns >= LOI_STINT_INNINGS and bowl_avg > 0 and bowl_econ > 0:
        boei = BOWL_K / (bowl_avg * bowl_econ / 6) * (bowl_inns ** LONGEVITY_EXP) * boei_scale

    aei = bei + boei
    return {"BEI": round(bei, 2), "BoEI": round(boei, 2), "AEI": round(aei, 2)}


def compute_loi_baseline_wpm(bat_cache: dict, bowl_cache: dict, min_matches: int = LOI_MIN_MATCHES) -> float:
    """Mean wpm across ALL LOI players (including non-bowlers as 0)."""
    wpms = []
    for pid in bat_cache:
        bat_df = bat_cache[pid]
        bat_clean = _prepare_bat_cum(bat_df)
        if len(bat_clean) < 2:
            continue
        total_mat = len(bat_clean)
        if total_mat < min_matches:
            continue
        bowl_df = bowl_cache.get(pid)
        if bowl_df is not None:
            bowl_clean = _prepare_bowl_cum(bowl_df)
            if len(bowl_clean) > 0:
                last_wkts = float(bowl_clean.iloc[-1]["Wkts"]) if not pd.isna(bowl_clean.iloc[-1]["Wkts"]) else 0
            else:
                last_wkts = 0
        else:
            last_wkts = 0
        wpms.append(last_wkts / total_mat)
    return float(np.mean(wpms)) if wpms else 1.0


def compute_loi_boei_scale(
    bat_agg: pd.DataFrame, bowl_agg: pd.DataFrame, min_matches: int = LOI_MIN_MATCHES,
) -> float:
    """Compute BoEI normalization scale so mean(BEI) ≈ mean(BoEI) across qualifying players."""
    bei_vals = []
    boei_vals = []
    for _, row in bat_agg.iterrows():
        try:
            mat = int(row["Mat"])
            if mat < min_matches:
                continue
            bat_inns = int(row["Inns"])
            bat_avg = float(row["Ave"]) if pd.notna(row["Ave"]) and str(row["Ave"]) != "-" else 0
            bat_sr = float(row["SR"]) if pd.notna(row["SR"]) and str(row["SR"]) != "-" else 0

            pid = row["player_id"]
            bowl_row = bowl_agg[bowl_agg["player_id"] == pid]
            bowl_inns = int(bowl_row["Inns"].values[0]) if len(bowl_row) > 0 else 0
            bowl_avg = float(bowl_row["Ave"].values[0]) if len(bowl_row) > 0 and pd.notna(bowl_row["Ave"].values[0]) and str(bowl_row["Ave"].values[0]) != "-" else 0
            bowl_econ = float(bowl_row["Econ"].values[0]) if len(bowl_row) > 0 and pd.notna(bowl_row["Econ"].values[0]) and str(bowl_row["Econ"].values[0]) != "-" else 0

            idx = compute_loi_career_indices(bat_inns, bat_avg, bat_sr, bowl_inns, bowl_avg, bowl_econ, boei_scale=1.0)
            if idx["BEI"] > 0:
                bei_vals.append(idx["BEI"])
            if idx["BoEI"] > 0:
                boei_vals.append(idx["BoEI"])
        except Exception:
            continue
    if not boei_vals or not bei_vals:
        return 1.0
    return float(np.mean(bei_vals)) / float(np.mean(boei_vals))


def _scrape_loi_era_aggregate(
    start_year: int, end_year: int, cricket_class: int = 2, extra_params: str = "",
) -> dict | None:
    """Scrape overall LOI figures (Runs, Wkts, Ave, RPO) for a date range."""
    url = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class={cricket_class}{extra_params};spanmin1=01+Jan+{start_year};spanmax1=31+Dec+{end_year};"
        f"spanval1=span;template=results;type=aggregate"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")
        tables = soup.select("table.engineTable")
        for table in tables:
            rows = table.select("tr.data1")
            if not rows:
                continue
            cells = rows[0].find_all("td")
            headers = [th.get_text(strip=True) for th in table.select("tr th")]
            if "Runs" not in headers or "Wkts" not in headers:
                continue
            vals = [c.get_text(strip=True) for c in cells]
            row_dict = dict(zip(headers, vals))
            runs = int(row_dict["Runs"].replace(",", ""))
            wkts = int(row_dict["Wkts"].replace(",", ""))
            balls = int(row_dict.get("Balls", "0").replace(",", "")) if "Balls" in row_dict else 0
            ave = float(row_dict["Ave"]) if row_dict.get("Ave", "-") != "-" else (runs / wkts if wkts else 0)
            rpo = float(row_dict["RPO"]) if row_dict.get("RPO", "-") != "-" else (6 * runs / balls if balls else 0)
            return {"runs": runs, "wkts": wkts, "ave": round(ave, 2), "rpo": round(rpo, 2)}
    except Exception as e:
        print(f"    WARNING: Failed to scrape LOI era {start_year}-{end_year}: {e}")
    return None


def scrape_loi_era_averages(
    spans: set[tuple[int, int]],
    cricket_class: int = 2,
    cache_path: Path = ODI_ERA_CACHE_PATH,
    delay: float = 0.3,
    extra_params: str = "",
) -> dict[tuple[int, int], dict]:
    """Scrape LOI era averages for all unique career spans, with caching."""
    cache = _load_loi_cache(cache_path)
    current_year = datetime.now().year
    to_scrape = []
    for span in spans:
        if span not in cache:
            to_scrape.append(span)
        elif span[1] >= current_year:
            to_scrape.append(span)

    if not to_scrape:
        print(f"  LOI era cache complete: {len(cache)} spans")
        return cache

    print(f"  Scraping LOI era averages for {len(to_scrape)} spans...")
    for i, (sy, ey) in enumerate(sorted(to_scrape)):
        result = _scrape_loi_era_aggregate(sy, ey, cricket_class, extra_params)
        if result:
            cache[(sy, ey)] = result
        if i > 0 and i % 50 == 0:
            _save_loi_cache(cache, cache_path)
            print(f"    {i}/{len(to_scrape)} done...")
        time.sleep(delay)

    _save_loi_cache(cache, cache_path)
    print(f"  LOI era cache: {len(cache)} spans")
    return cache


def compute_loi_all_time(era_cache: dict) -> tuple[float, float]:
    """Compute all-time LOI average and RPO from the broadest span in cache."""
    if not era_cache:
        return 31.0, 4.7
    broadest = max(era_cache.keys(), key=lambda k: k[1] - k[0])
    return era_cache[broadest]["ave"], era_cache[broadest]["rpo"]


def _safe_float(val, default=0.0) -> float:
    """Safely convert a value to float, returning default for NaN/'-'/missing."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return default
    s = str(val).strip()
    if s in ("-", "", "nan"):
        return default
    try:
        return float(s)
    except (ValueError, TypeError):
        return default


def compute_loi_all_players(
    bat_cache: dict,
    bowl_cache: dict,
    bat_agg: pd.DataFrame,
    bowl_agg: pd.DataFrame,
    player_info: pd.DataFrame,
    boei_scale: float,
    global_match_stats: dict | None = None,
    all_time_avg: float = 31.0,
    all_time_rpo: float = 4.7,
    min_matches: int = LOI_MIN_MATCHES,
    team_map: dict | None = None,
) -> list[dict]:
    bat_agg_idx = bat_agg.set_index("player_id")
    bowl_agg_idx = bowl_agg.set_index("player_id")

    records = []
    for pid in bat_cache:
        try:
            bat_df = bat_cache[pid]
            bowl_df = bowl_cache.get(pid)
            name = bat_df.attrs.get("player_name", "Unknown")

            if pid not in bat_agg_idx.index:
                continue
            ba = bat_agg_idx.loc[pid]
            total_matches = int(ba["Mat"])
            if total_matches < min_matches:
                continue

            bat_inns = int(ba["Inns"])
            career_bat_avg = _safe_float(ba["Ave"])
            career_bat_sr = _safe_float(ba["SR"])

            bowl_inns = 0
            career_bowl_avg = 0.0
            career_bowl_econ = 0.0
            if pid in bowl_agg_idx.index:
                bo = bowl_agg_idx.loc[pid]
                bowl_inns = int(_safe_float(bo["Inns"], 0))
                career_bowl_avg = _safe_float(bo["Ave"])
                career_bowl_econ = _safe_float(bo["Econ"])

            idx = compute_loi_career_indices(
                bat_inns, career_bat_avg, career_bat_sr,
                bowl_inns, career_bowl_avg, career_bowl_econ,
                boei_scale=boei_scale,
            )

            bat_stints, bowl_stints = compute_stints_loi(bat_df, bowl_df)

            info_row = player_info[player_info["player_id"] == pid]
            country = info_row["country"].values[0] if len(info_row) > 0 else ""

            bei = idx["BEI"]
            boei = idx["BoEI"]

            bat_clean = _prepare_bat_cum(bat_df)
            pf = compute_player_pitch_factors(
                bat_clean, global_match_stats or {}, all_time_avg, all_time_rpo
            )
            match_avg = pf["match_avg"]
            match_rpo = pf["match_rpo"]
            bat_pitch_factor = pf["bat_pitch_factor"]
            bowl_pitch_factor = pf["bowl_pitch_factor"]
            bei = round(bei * bat_pitch_factor, 2)
            boei = round(boei * bowl_pitch_factor, 2)

            aei = round(bei + boei, 2)
            franchises = team_map.get(int(pid), []) if team_map else []
            records.append({
                "player_id": int(pid),
                "player_name": name,
                "country": country,
                "franchises": franchises,
                "BEI": bei,
                "BoEI": boei,
                "AEI": aei,
                "matches": total_matches,
                "bat_stints": bat_stints,
                "bowl_stints": bowl_stints,
                "match_avg": match_avg,
                "match_rpo": match_rpo,
                "bat_pitch_factor": bat_pitch_factor,
                "bowl_pitch_factor": bowl_pitch_factor,
                "career_bat_avg": round(career_bat_avg, 2) if career_bat_avg > 0 else None,
                "career_bat_sr": round(career_bat_sr, 2) if career_bat_sr > 0 else None,
                "career_bowl_avg": round(career_bowl_avg, 2) if career_bowl_avg > 0 else None,
                "career_bowl_econ": round(career_bowl_econ, 2) if career_bowl_econ > 0 else None,
            })
        except Exception:
            continue

    records.sort(key=lambda r: r["AEI"], reverse=True)
    return records


def build_loi_rankings_json(
    all_players: list[dict],
    boei_scale: float,
    baseline_wpm: float = 1.0,
    all_time_avg: float = 31.0,
    all_time_rpo: float = 4.7,
    format_name: str = "ODI",
    full_member_only: bool = True,
    min_matches: int = LOI_MIN_MATCHES,
) -> dict:
    """Build rankings JSON for an LOI format. Same structure as Test rankings."""
    rating_stats = compute_ratings(all_players)

    ranked_players = [p for p in all_players if is_full_member(p["country"])] if full_member_only else all_players
    bei_sorted = sorted(ranked_players, key=lambda p: p["BEI"], reverse=True)
    boei_sorted = sorted(ranked_players, key=lambda p: p["BoEI"], reverse=True)

    allrounders = []
    for p in ranked_players:
        if p["BEI_rating"] >= LOI_MIN_AR_RATING and p["BoEI_rating"] >= LOI_MIN_AR_RATING:
            geo = np.sqrt(p["BEI_rating"] * p["BoEI_rating"])
            balance = min(p["BEI"], p["BoEI"]) / p["AEI"] if p["AEI"] > 0 else 0
            allrounders.append({**p, "balance": round(balance * 100, 1), "geo_rating": round(geo)})
    allrounders.sort(key=lambda p: p["geo_rating"], reverse=True)

    def player_summary(p, extra_fields=None):
        d = {
            "name": p["player_name"],
            "country": p["country"],
            "matches": p["matches"],
            "BEI": p["BEI"],
            "BoEI": p["BoEI"],
            "AEI": p["AEI"],
            "bat_rating": p["BEI_rating"],
            "bowl_rating": p["BoEI_rating"],
            "ar_rating": p.get("geo_rating", p["AEI_rating"]),
        }
        if p.get("franchises"):
            d["franchises"] = p["franchises"]
        if extra_fields:
            for k in extra_fields:
                d[k] = p[k]
        return d

    bat_rank_map = {}
    for rank, p in enumerate(bei_sorted, 1):
        bat_rank_map[p["player_name"]] = rank if p["BEI"] > 0 else None

    bowl_rank_map = {}
    for rank, p in enumerate(boei_sorted, 1):
        bowl_rank_map[p["player_name"]] = rank if p["BoEI"] > 0 else None

    ar_rank_map = {}
    ar_geo_map = {}
    for rank, p in enumerate(allrounders, 1):
        ar_rank_map[p["player_name"]] = rank
        ar_geo_map[p["player_name"]] = p["geo_rating"]

    all_players_index = [
        {
            "name": p["player_name"],
            "country": p["country"],
            "matches": p["matches"],
            "BEI": p["BEI"],
            "BoEI": p["BoEI"],
            "AEI": p["AEI"],
            "bat_rating": p["BEI_rating"],
            "bowl_rating": p["BoEI_rating"],
            "ar_rating": ar_geo_map.get(p["player_name"], p["AEI_rating"]),
            "bat_rank": bat_rank_map.get(p["player_name"]),
            "bowl_rank": bowl_rank_map.get(p["player_name"]),
            "ar_rank": ar_rank_map.get(p["player_name"]),
            "bat_stints": p["bat_stints"],
            "bowl_stints": p["bowl_stints"],
            "match_avg": p.get("match_avg"),
            "match_rpo": p.get("match_rpo"),
            "bat_pitch_factor": p.get("bat_pitch_factor"),
            "bowl_pitch_factor": p.get("bowl_pitch_factor"),
            "career_bat_avg": p.get("career_bat_avg"),
            "career_bat_sr": p.get("career_bat_sr"),
            "career_bowl_avg": p.get("career_bowl_avg"),
            "career_bowl_econ": p.get("career_bowl_econ"),
        }
        for p in all_players
    ]

    return {
        "metadata": {
            "format": format_name,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "total_players": len(all_players),
            "boei_scale": round(boei_scale, 4),
            "formula": "career",
            "bowl_k": BOWL_K,
            "longevity_exp": LONGEVITY_EXP,
            "min_matches": min_matches,
            "min_ar_rating": LOI_MIN_AR_RATING,
            "stint_innings": LOI_STINT_INNINGS,
            "rating_base": RATING_BASE,
            "rating_k": RATING_K,
            "all_time_avg": round(all_time_avg, 2),
            "all_time_rpo": round(all_time_rpo, 2),
        },
        "batting_top25": [player_summary(p) for p in bei_sorted[:TOP_N]],
        "bowling_top25": [player_summary(p) for p in boei_sorted[:TOP_N]],
        "allrounder_top25": [player_summary(p, ["balance"]) for p in allrounders[:TOP_N]],
        "all_players": all_players_index,
    }


def run_loi_pipeline(
    cricket_class: int = 2,
    format_name: str = "ODI",
    bat_agg_path: Path = ODI_BAT_AGG_PATH,
    bowl_agg_path: Path = ODI_BOWL_AGG_PATH,
    bat_cum_path: Path = ODI_BAT_CUM_CACHE_PATH,
    bowl_cum_path: Path = ODI_BOWL_CUM_CACHE_PATH,
    global_match_cache_path: Path = ODI_GLOBAL_MATCH_CACHE,
    force_scrape: bool = False,
    extra_params: str = "",
    min_matches: int = LOI_MIN_MATCHES,
    full_member_only: bool = True,
    country_map: dict | None = None,
    team_map: dict | None = None,
    name_overrides: dict | None = None,
) -> dict:
    """Full pipeline for an LOI format. Returns rankings JSON dict."""
    print(f"\n{'=' * 60}")
    print(f"GOAT Cricket Rankings — {format_name}")
    print(f"{'=' * 60}")

    # 1. Aggregate player lists
    if bat_agg_path.exists() and not force_scrape:
        bat_agg = pd.read_pickle(bat_agg_path)
        print(f"Loaded cached {format_name} batting aggregate: {len(bat_agg)} players")
    else:
        print(f"Scraping {format_name} batting aggregate...")
        bat_agg = scrape_statsguru_aggregate("batting", min_matches=min_matches, cricket_class=cricket_class, extra_params=extra_params)
        bat_agg.to_pickle(bat_agg_path)
        print(f"  Saved {len(bat_agg)} players")

    if bowl_agg_path.exists() and not force_scrape:
        bowl_agg = pd.read_pickle(bowl_agg_path)
        print(f"Loaded cached {format_name} bowling aggregate: {len(bowl_agg)} players")
    else:
        print(f"Scraping {format_name} bowling aggregate...")
        bowl_agg = scrape_statsguru_aggregate("bowling", min_matches=min_matches, cricket_class=cricket_class, extra_params=extra_params)
        bowl_agg.to_pickle(bowl_agg_path)
        print(f"  Saved {len(bowl_agg)} players")

    all_ids = sorted(set(bat_agg["player_id"].tolist()) | set(bowl_agg["player_id"].tolist()))
    print(f"\nUnique {format_name} players with {min_matches}+ matches: {len(all_ids)}")

    info_cols = ["player_id", "player_name", "country"]
    if "Span" in bat_agg.columns:
        info_cols.append("Span")
    player_info = bat_agg[info_cols].drop_duplicates("player_id")
    bowl_info_cols = ["player_id", "player_name", "country"]
    if "Span" in bowl_agg.columns:
        bowl_info_cols.append("Span")
    bowl_only = bowl_agg[~bowl_agg["player_id"].isin(player_info["player_id"])][
        bowl_info_cols
    ].drop_duplicates("player_id")
    player_info = pd.concat([player_info, bowl_only], ignore_index=True)

    if country_map:
        def _fill_country(row):
            if row["country"] and str(row["country"]).strip():
                return row["country"]
            return country_map.get(int(row["player_id"]), "IND")
        player_info["country"] = player_info.apply(_fill_country, axis=1)
        print(f"  Filled {sum(player_info['country'] != '')} player nationalities from cross-format data")

    # 2. Per-player cumulative data
    if force_scrape or not bat_cum_path.exists():
        bat_cache, bowl_cache = scrape_loi_all_players(
            all_ids, cricket_class, bat_cum_path, bowl_cum_path, extra_params=extra_params,
        )
    else:
        bat_cache = _load_loi_cache(bat_cum_path)
        bowl_cache = _load_loi_cache(bowl_cum_path)
        missing = [pid for pid in all_ids if pid not in bat_cache]
        if missing:
            print(f"  {len(missing)} new players to scrape...")
            bat_cache, bowl_cache = scrape_loi_all_players(
                all_ids, cricket_class, bat_cum_path, bowl_cum_path, extra_params=extra_params,
            )
        else:
            print(f"  LOI cumulative cache: {len(bat_cache)} bat, {len(bowl_cache)} bowl")

    # 3. Pitch difficulty: all-time aggregate + global match stats
    print(f"\nScraping {format_name} all-time aggregate...")
    all_time_data = _scrape_all_time_aggregate(cricket_class, extra_params)
    all_time_avg = all_time_data["ave"]
    all_time_rpo = all_time_data["rpo"]
    print(f"  All-time {format_name} avg: {all_time_avg}, RPO: {all_time_rpo}")

    print(f"Loading {format_name} global match stats (pitch difficulty)...")
    global_match_stats = scrape_global_match_stats(
        cricket_class, extra_params, global_match_cache_path, force=force_scrape,
    )

    # 4. Baseline WPM and BoEI scale
    print(f"\nComputing {format_name} baseline wpm...")
    baseline_wpm = compute_loi_baseline_wpm(bat_cache, bowl_cache, min_matches=min_matches)
    print(f"  BASELINE_WPM = {baseline_wpm:.2f}")

    print(f"Computing {format_name} BoEI scale...")
    boei_scale = compute_loi_boei_scale(bat_agg, bowl_agg, min_matches=min_matches)
    print(f"  BOEI_SCALE = {boei_scale:.4f}")

    # 5. Compute all players (career formula + stint charts)
    print(f"Computing {format_name} indices for all players...")
    all_players = compute_loi_all_players(
        bat_cache, bowl_cache, bat_agg, bowl_agg, player_info, boei_scale,
        global_match_stats=global_match_stats,
        all_time_avg=all_time_avg, all_time_rpo=all_time_rpo,
        min_matches=min_matches,
        team_map=team_map,
    )
    print(f"  Computed indices for {len(all_players)} players")

    # 6. Build JSON
    print(f"Building {format_name} rankings JSON...")
    rankings = build_loi_rankings_json(
        all_players, boei_scale,
        baseline_wpm=baseline_wpm, all_time_avg=all_time_avg,
        all_time_rpo=all_time_rpo, format_name=format_name,
        full_member_only=full_member_only, min_matches=min_matches,
    )

    return rankings


# ─── JSON Output ─────────────────────────────────────────────────────────────


def _z_to_rating(z: float) -> int:
    if z >= 0:
        return max(0, int(round(RATING_BASE + RATING_K * np.sqrt(z))))
    return max(0, int(round(RATING_BASE + RATING_K * z)))


def compute_ratings(all_players: list[dict]) -> dict:
    """Two-pass rating computation.

    Pass 1: compute BEI / BoEI ratings for every player.
    Pass 2: identify allrounders (min rating in both >= MIN_AR_RATING),
            compute AEI stats from that population, then assign AEI ratings.
    """
    bei_vals = np.array([p["BEI"] for p in all_players if p["BEI"] > 0])
    boei_vals = np.array([p["BoEI"] for p in all_players if p["BoEI"] > 0])

    stats = {
        "BEI": (float(np.median(bei_vals)), float(bei_vals.std())),
        "BoEI": (float(np.median(boei_vals)), float(boei_vals.std())),
    }

    # Pass 1: BEI and BoEI ratings
    for p in all_players:
        for metric in ["BEI", "BoEI"]:
            mu, sigma = stats[metric]
            if sigma == 0:
                sigma = 1
            val = p[metric]
            if val > 0:
                p[f"{metric}_rating"] = _z_to_rating((val - mu) / sigma)
            else:
                p[f"{metric}_rating"] = 0

    # Pass 2: AEI ratings via z-scores against the FULL population.
    # Using all 870 players (not just ~50 qualifying allrounders) gives
    # stable stats. The allrounder leaderboard then filters to qualified
    # players only. This keeps the same sqrt-compressed z-score formula
    # as batting/bowling, so the scale feels consistent (Kallis > 1000
    # like Bradman for batting).
    aei_vals = np.array([p["AEI"] for p in all_players if p["AEI"] > 0])
    stats["AEI"] = (float(np.median(aei_vals)), float(aei_vals.std())) if len(aei_vals) > 1 else (0.0, 1.0)

    mu, sigma = stats["AEI"]
    if sigma == 0:
        sigma = 1
    for p in all_players:
        if p["AEI"] > 0:
            z = (p["AEI"] - mu) / sigma
            p["AEI_rating"] = _z_to_rating(z)
        else:
            p["AEI_rating"] = 0

    return stats


def build_rankings_json(all_players: list[dict], boei_scale: float, baseline_wpi: float = 1.46, baseline_sr: float = 79.9, all_time_avg: float = 31.91) -> dict:
    rating_stats = compute_ratings(all_players)

    fm_players = [p for p in all_players if is_full_member(p["country"])]
    bei_sorted = sorted(fm_players, key=lambda p: p["BEI"], reverse=True)
    boei_sorted = sorted(fm_players, key=lambda p: p["BoEI"], reverse=True)

    allrounders = []
    for p in fm_players:
        if p["BEI_rating"] >= MIN_AR_RATING and p["BoEI_rating"] >= MIN_AR_RATING:
            geo = np.sqrt(p["BEI_rating"] * p["BoEI_rating"])
            balance = min(p["BEI"], p["BoEI"]) / p["AEI"] if p["AEI"] > 0 else 0
            allrounders.append({**p, "balance": round(balance * 100, 1), "geo_rating": round(geo)})
    allrounders.sort(key=lambda p: p["geo_rating"], reverse=True)

    def player_summary(p, extra_fields=None):
        d = {
            "name": p["player_name"],
            "country": p["country"],
            "matches": p["matches"],
            "BEI": p["BEI"],
            "BoEI": p["BoEI"],
            "AEI": p["AEI"],
            "bat_rating": p["BEI_rating"],
            "bowl_rating": p["BoEI_rating"],
            "ar_rating": p.get("geo_rating", p["AEI_rating"]),
            "career_bat_avg": p.get("career_bat_avg"),
            "career_bowl_avg": p.get("career_bowl_avg"),
            "career_bowl_sr": p.get("career_bowl_sr"),
        }
        if extra_fields:
            for k in extra_fields:
                d[k] = p[k]
        return d

    bat_rank_map = {}
    for rank, p in enumerate(bei_sorted, 1):
        bat_rank_map[p["player_name"]] = rank if p["BEI"] > 0 else None

    bowl_rank_map = {}
    for rank, p in enumerate(boei_sorted, 1):
        bowl_rank_map[p["player_name"]] = rank if p["BoEI"] > 0 else None

    ar_rank_map = {}
    ar_geo_map = {}
    for rank, p in enumerate(allrounders, 1):
        ar_rank_map[p["player_name"]] = rank
        ar_geo_map[p["player_name"]] = p["geo_rating"]

    all_players_index = [
        {
            "name": p["player_name"],
            "country": p["country"],
            "matches": p["matches"],
            "BEI": p["BEI"],
            "BoEI": p["BoEI"],
            "AEI": p["AEI"],
            "bat_rating": p["BEI_rating"],
            "bowl_rating": p["BoEI_rating"],
            "ar_rating": ar_geo_map.get(p["player_name"], p["AEI_rating"]),
            "bat_rank": bat_rank_map.get(p["player_name"]),
            "bowl_rank": bowl_rank_map.get(p["player_name"]),
            "ar_rank": ar_rank_map.get(p["player_name"]),
            "stints": p["stints"],
            "match_avg": p.get("match_avg"),
            "bat_pitch_factor": p.get("bat_pitch_factor"),
            "bowl_pitch_factor": p.get("bowl_pitch_factor"),
            "career_bat_avg": p.get("career_bat_avg"),
            "career_bowl_avg": p.get("career_bowl_avg"),
            "career_bowl_sr": p.get("career_bowl_sr"),
        }
        for p in all_players
    ]

    return {
        "metadata": {
            "format": "Tests",
            "formula": "career",
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "total_players": len(all_players),
            "boei_scale": round(boei_scale, 4),
            "baseline_wpi": round(baseline_wpi, 2),
            "baseline_sr": round(baseline_sr, 1),
            "sr_exp": TEST_SR_EXP,
            "bowl_k": BOWL_K,
            "longevity_exp": LONGEVITY_EXP,
            "min_bowl_inns": TEST_MIN_BOWL_INNS,
            "min_matches": MIN_MATCHES,
            "min_ar_rating": MIN_AR_RATING,
            "rating_base": RATING_BASE,
            "rating_k": RATING_K,
            "all_time_avg": round(all_time_avg, 2),
        },
        "batting_top25": [player_summary(p) for p in bei_sorted[:TOP_N]],
        "bowling_top25": [player_summary(p) for p in boei_sorted[:TOP_N]],
        "allrounder_top25": [player_summary(p, ["balance"]) for p in allrounders[:TOP_N]],
        "all_players": all_players_index,
    }


# ─── Main ────────────────────────────────────────────────────────────────────


def main():
    do_scrape = "--scrape" in sys.argv

    print("=" * 60)
    print("GOAT Cricket Rankings — Update")
    print("=" * 60)

    bat_agg, bowl_agg = load_or_scrape_aggregates(force_scrape=do_scrape)

    all_ids = sorted(set(bat_agg["player_id"].tolist()) | set(bowl_agg["player_id"].tolist()))
    print(f"\nUnique Test players with {MIN_MATCHES}+ matches: {len(all_ids)}")

    info_cols = ["player_id", "player_name", "country"]
    if "Span" in bat_agg.columns:
        info_cols.append("Span")
    player_info = bat_agg[info_cols].drop_duplicates("player_id")
    bowl_info_cols = ["player_id", "player_name", "country"]
    if "Span" in bowl_agg.columns:
        bowl_info_cols.append("Span")
    bowl_only = bowl_agg[~bowl_agg["player_id"].isin(player_info["player_id"])][
        bowl_info_cols
    ].drop_duplicates("player_id")
    player_info = pd.concat([player_info, bowl_only], ignore_index=True)

    if do_scrape:
        cache = scrape_all_players(all_ids)
        innings_cache = scrape_all_innings(all_ids)
    else:
        cache = load_allround_cache()
        print(f"Loaded allround cache: {len(cache)} players")
        innings_cache = load_innings_cache()
        print(f"Loaded innings cache: {len(innings_cache)} players")

    # Pitch difficulty: all-time aggregate + global match stats
    print("\nScraping all-time Test aggregate...")
    all_time_data = _scrape_all_time_aggregate(cricket_class=1)
    all_time_avg = all_time_data["ave"]
    print(f"  All-time Test average: {all_time_avg}")

    print("Loading global Test match stats (pitch difficulty)...")
    global_match_stats = scrape_global_match_stats(
        cricket_class=1, cache_path=TEST_GLOBAL_MATCH_CACHE, force=do_scrape,
    )

    print("\nComputing baseline wickets per innings (aggregate)...")
    baseline_wpi = compute_test_baseline_wpi(bowl_agg)
    print(f"  BASELINE_WPI = {baseline_wpi:.2f}")

    print("Computing baseline bowling strike rate (aggregate)...")
    baseline_sr = compute_test_baseline_sr(bowl_agg)
    print(f"  BASELINE_SR = {baseline_sr:.1f}")

    print("Computing BoEI normalization scale (aggregate)...")
    boei_scale = compute_test_boei_scale(bat_agg, bowl_agg, baseline_wpi, baseline_sr)
    print(f"  BOEI_SCALE = {boei_scale:.4f}")

    print("Computing indices for all players (career formula + pitch difficulty)...")
    all_players = compute_all_players(
        cache, innings_cache, bat_agg, bowl_agg, player_info, boei_scale,
        baseline_wpi=baseline_wpi, baseline_sr=baseline_sr,
        global_match_stats=global_match_stats, all_time_avg=all_time_avg,
    )
    print(f"  Computed indices for {len(all_players)} players")

    print("Building Test rankings JSON...")
    rankings = build_rankings_json(all_players, boei_scale, baseline_wpi=baseline_wpi, baseline_sr=baseline_sr, all_time_avg=all_time_avg)

    out_path = SITE_DIR / "rankings.json"
    with open(out_path, "w") as f:
        json.dump(rankings, f, separators=(",", ":"))

    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"\nWrote {out_path} ({size_mb:.1f} MB)")
    print(f"  Batting top 3: {', '.join(p['name'] for p in rankings['batting_top25'][:3])}")
    print(f"  Bowling top 3: {', '.join(p['name'] for p in rankings['bowling_top25'][:3])}")
    print(f"  Allrounder top 3: {', '.join(p['name'] for p in rankings['allrounder_top25'][:3])}")

    # ── ODI Pipeline ──
    odi_rankings = run_loi_pipeline(
        cricket_class=2,
        format_name="ODI",
        bat_agg_path=ODI_BAT_AGG_PATH,
        bowl_agg_path=ODI_BOWL_AGG_PATH,
        bat_cum_path=ODI_BAT_CUM_CACHE_PATH,
        bowl_cum_path=ODI_BOWL_CUM_CACHE_PATH,
        global_match_cache_path=ODI_GLOBAL_MATCH_CACHE,
        force_scrape=do_scrape,
    )

    odi_out_path = SITE_DIR / "odi_rankings.json"
    with open(odi_out_path, "w") as f:
        json.dump(odi_rankings, f, separators=(",", ":"))

    size_mb = odi_out_path.stat().st_size / 1024 / 1024
    print(f"\nWrote {odi_out_path} ({size_mb:.1f} MB)")
    print(f"  ODI Batting top 3: {', '.join(p['name'] for p in odi_rankings['batting_top25'][:3])}")
    print(f"  ODI Bowling top 3: {', '.join(p['name'] for p in odi_rankings['bowling_top25'][:3])}")
    if odi_rankings["allrounder_top25"]:
        print(f"  ODI Allrounder top 3: {', '.join(p['name'] for p in odi_rankings['allrounder_top25'][:3])}")

    # ── T20I Pipeline ──
    t20i_rankings = run_loi_pipeline(
        cricket_class=3,
        format_name="T20I",
        bat_agg_path=T20I_BAT_AGG_PATH,
        bowl_agg_path=T20I_BOWL_AGG_PATH,
        bat_cum_path=T20I_BAT_CUM_CACHE_PATH,
        bowl_cum_path=T20I_BOWL_CUM_CACHE_PATH,
        global_match_cache_path=T20I_GLOBAL_MATCH_CACHE,
        force_scrape=do_scrape,
        min_matches=LOI_MIN_MATCHES_T20,
    )

    t20i_out_path = SITE_DIR / "t20i_rankings.json"
    with open(t20i_out_path, "w") as f:
        json.dump(t20i_rankings, f, separators=(",", ":"))

    size_mb = t20i_out_path.stat().st_size / 1024 / 1024
    print(f"\nWrote {t20i_out_path} ({size_mb:.1f} MB)")
    print(f"  T20I Batting top 3: {', '.join(p['name'] for p in t20i_rankings['batting_top25'][:3])}")
    print(f"  T20I Bowling top 3: {', '.join(p['name'] for p in t20i_rankings['bowling_top25'][:3])}")
    if t20i_rankings["allrounder_top25"]:
        print(f"  T20I Allrounder top 3: {', '.join(p['name'] for p in t20i_rankings['allrounder_top25'][:3])}")

    # ── IPL Pipeline ──
    # Build nationality map from international aggregates for IPL players
    ipl_country_map = {}
    for src_path in [BAT_AGG_PATH, BOWL_AGG_PATH, ODI_BAT_AGG_PATH, ODI_BOWL_AGG_PATH,
                     T20I_BAT_AGG_PATH, T20I_BOWL_AGG_PATH]:
        if src_path.exists():
            df = pd.read_pickle(src_path)
            for _, r in df.iterrows():
                pid = int(r["player_id"])
                c = str(r.get("country", "")).strip()
                if c and pid not in ipl_country_map:
                    ipl_country_map[pid] = c
    # Players below international thresholds but known non-Indian
    _ipl_overrides = {
        5674: "AUS",    # BJ Hodge
        326637: "AUS",  # CA Lynn
        439952: "SA",   # CH Morris
        4864: "AUS",    # DT Christian
        5961: "AUS",    # MC Henriques
        319439: "NZ",   # MJ McClenaghan
        1194795: "SL",  # M Pathirana
        261354: "AUS",  # NM Coulter-Nile
        1182529: "AFG", # Noor Ahmad
    }
    for pid, c in _ipl_overrides.items():
        if pid not in ipl_country_map:
            ipl_country_map[pid] = c
    print(f"\nBuilt IPL nationality map: {len(ipl_country_map)} players from international data")

    ipl_team_map = {}
    if IPL_TEAM_MAP_PATH.exists():
        ipl_team_map = pd.read_pickle(IPL_TEAM_MAP_PATH)
        print(f"Loaded IPL team map: {len(ipl_team_map)} players")

    ipl_rankings = run_loi_pipeline(
        cricket_class=6,
        format_name="IPL",
        bat_agg_path=IPL_BAT_AGG_PATH,
        bowl_agg_path=IPL_BOWL_AGG_PATH,
        bat_cum_path=IPL_BAT_CUM_CACHE_PATH,
        bowl_cum_path=IPL_BOWL_CUM_CACHE_PATH,
        global_match_cache_path=IPL_GLOBAL_MATCH_CACHE,
        force_scrape=do_scrape,
        extra_params=";trophy=117",
        min_matches=IPL_MIN_MATCHES,
        full_member_only=False,
        country_map=ipl_country_map,
        team_map=ipl_team_map,
    )

    ipl_out_path = SITE_DIR / "ipl_rankings.json"
    with open(ipl_out_path, "w") as f:
        json.dump(ipl_rankings, f, separators=(",", ":"))

    size_mb = ipl_out_path.stat().st_size / 1024 / 1024
    print(f"\nWrote {ipl_out_path} ({size_mb:.1f} MB)")
    print(f"  IPL Batting top 3: {', '.join(p['name'] for p in ipl_rankings['batting_top25'][:3])}")
    print(f"  IPL Bowling top 3: {', '.join(p['name'] for p in ipl_rankings['bowling_top25'][:3])}")
    if ipl_rankings["allrounder_top25"]:
        print(f"  IPL Allrounder top 3: {', '.join(p['name'] for p in ipl_rankings['allrounder_top25'][:3])}")

    print("\nDone!")


if __name__ == "__main__":
    main()
