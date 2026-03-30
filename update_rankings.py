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
from scipy.stats import gaussian_kde

# ─── Constants ───────────────────────────────────────────────────────────────

BOWL_K = 1000
MIN_STINT_BAT_INN = 10
MIN_STINT_BOWL_INN = 10
ALPHA = 0.70
LOI_ALPHA = 0.70
MIN_MATCHES = 20
LOI_MIN_MATCHES = 50
STINT_SIZE = 10
TOP_N = 100
RATING_BASE = 350
RATING_K = 351  # sqrt-compressed: 900+=elite, 800+=great, 700+=very good
MIN_AR_RATING = 250  # min rating in both bat & bowl to qualify as allrounder (Tests)
LOI_MIN_AR_RATING = 250  # same threshold; ranking uses geometric mean to handle balance

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

# ─── Scraping ────────────────────────────────────────────────────────────────


def _parse_player_country(name_str: str) -> tuple[str, str]:
    m = re.match(r"^(.+?)\(([^)]+)\)$", name_str.strip())
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return name_str.strip(), ""


def scrape_statsguru_aggregate(
    stat_type: str = "batting", min_matches: int = 20, page_size: int = 200,
    cricket_class: int = 1,
) -> pd.DataFrame:
    base = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class={cricket_class};template=results;type={stat_type};"
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

    return pd.DataFrame(all_rows)


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


def excellence_indices(stints: list[dict], boei_scale: float = 1.0, median_wpm: float = 2.75) -> dict:
    total_matches = sum(s["matches"] for s in stints)
    denom = total_matches ** ALPHA if total_matches > 0 else 1.0

    bat_sum = sum(
        s["bat_avg"] * s["matches"] for s in stints if s["bat_avg"] is not None
    )
    bowl_sum = sum(
        s["bowl_score"] * np.sqrt(s["wpm"] / median_wpm) * s["matches"]
        for s in stints if s["bowl_score"] is not None and s["wpm"] is not None
    )

    bei = bat_sum / denom
    boei = bowl_sum * boei_scale / denom
    aei = bei + boei

    return {"BEI": round(bei, 2), "BoEI": round(boei, 2), "AEI": round(aei, 2), "matches": total_matches}


def compute_baseline_wpm(cache: dict) -> float:
    """Mean wickets-per-match across ALL players (including non-bowlers as 0)."""
    wpms = []
    for pid, df in cache.items():
        try:
            df_clean = df.dropna(subset=["Mat"])
            if len(df_clean) < 2:
                continue
            last = df_clean.iloc[-1]
            mat = float(last["Mat"])
            wkts = float(last["Wkts"]) if last["Wkts"] > 0 else 0
            wpms.append(wkts / mat if mat > 0 else 0)
        except Exception:
            continue
    return float(np.mean(wpms)) if wpms else 1.4


def compute_boei_scale(cache: dict, innings_cache: dict, median_wpm: float = 2.75) -> float:
    bat_num = bat_den = bowl_num = bowl_den = 0.0
    for pid, df in cache.items():
        try:
            df_clean = df.dropna(subset=["Mat"])
            if len(df_clean) < 2:
                continue
            inn_data = innings_cache.get(pid)
            stints = compute_stints(df_clean, inn_data)
            for s in stints:
                if s["bat_avg"] is not None:
                    bat_num += s["bat_avg"] * s["matches"]
                    bat_den += s["matches"]
                if s["bowl_score"] is not None and s["wpm"] is not None:
                    bowl_num += s["bowl_score"] * np.sqrt(s["wpm"] / median_wpm) * s["matches"]
                    bowl_den += s["matches"]
        except Exception:
            continue
    if bowl_den == 0 or bat_den == 0:
        return 1.0
    return (bat_num / bat_den) / (bowl_num / bowl_den)


def compute_all_players(
    cache: dict,
    innings_cache: dict,
    player_info: pd.DataFrame,
    boei_scale: float,
    median_wpm: float = 2.75,
    era_cache: dict | None = None,
    all_time_avg: float = 31.91,
):
    span_map = {}
    if "Span" in player_info.columns:
        for _, row in player_info.iterrows():
            sp = parse_span(str(row.get("Span", "")))
            if sp:
                span_map[int(row["player_id"])] = sp

    records = []
    for pid, df in cache.items():
        try:
            name = df.attrs.get("player_name", "Unknown")
            df_clean = df.dropna(subset=["Mat"])
            if len(df_clean) < 2:
                continue
            inn_data = innings_cache.get(pid)
            stints = compute_stints(df_clean, inn_data)
            idx = excellence_indices(stints, boei_scale, median_wpm)
            info_row = player_info[player_info["player_id"] == pid]
            country = info_row["country"].values[0] if len(info_row) > 0 else ""

            bei = idx["BEI"]
            boei = idx["BoEI"]
            era_avg = all_time_avg
            bat_era_factor = 1.0
            bowl_era_factor = 1.0

            span = span_map.get(int(pid))
            if span and era_cache and span in era_cache:
                era_avg = era_cache[span]["ave"]
                if era_avg > 0:
                    bat_era_factor = round(all_time_avg / era_avg, 4)
                    bowl_era_factor = round(era_avg / all_time_avg, 4)
                    bei = round(bei * bat_era_factor, 2)
                    boei = round(boei * bowl_era_factor, 2)

            aei = round(bei + boei, 2)
            records.append({
                "player_id": int(pid),
                "player_name": name,
                "country": country,
                "BEI": bei,
                "BoEI": boei,
                "AEI": aei,
                "matches": idx["matches"],
                "stints": stints,
                "era_avg": era_avg,
                "bat_era_factor": bat_era_factor,
                "bowl_era_factor": bowl_era_factor,
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
    player_id: int, stat_type: str, cricket_class: int = 2
) -> pd.DataFrame | None:
    """Scrape full cumulative data (batting or bowling view) for a player."""
    url = (
        f"https://stats.espncricinfo.com/ci/engine/player/{player_id}.html?"
        f"class={cricket_class};template=results;type={stat_type};view=cumulative"
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
        bat_df = _scrape_cumulative_full(pid, "batting", cricket_class)
        time.sleep(0.15)
        bowl_df = _scrape_cumulative_full(pid, "bowling", cricket_class)

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
    """Compute batting and bowling stints separately, each based on 10-innings blocks.
    Returns (bat_stints, bowl_stints).
    """
    bat = _prepare_bat_cum(bat_df)
    if len(bat) < 2:
        return [], []

    total_matches = int(bat.iloc[-1]["Mat"])

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
        bat_metric = bat_avg * (bat_sr / 100) if bat_avg is not None and bat_sr is not None else None

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


def excellence_indices_loi(
    bat_stints: list[dict], bowl_stints: list[dict],
    total_matches: int, boei_scale: float = 1.0, baseline_wpm: float = 1.0,
) -> dict:
    """BEI/BoEI/AEI for LOI formats with separate batting/bowling stints.
    AEI uses balance-weighted sum: (BEI+BoEI) × sqrt(min/max) to reward dual-threat allrounders.
    """
    denom = total_matches ** LOI_ALPHA if total_matches > 0 else 1.0

    bat_sum = sum(
        s["bat_metric"] * s["matches"] for s in bat_stints if s["bat_metric"] is not None
    )
    bowl_sum = sum(
        s["bowl_metric"] * np.sqrt(s["wpm"] / baseline_wpm) * s["matches"]
        for s in bowl_stints if s["bowl_metric"] is not None and s["wpm"] is not None
    )

    bei = bat_sum / denom
    boei = bowl_sum * boei_scale / denom
    aei = bei + boei

    return {"BEI": round(bei, 2), "BoEI": round(boei, 2), "AEI": round(aei, 2), "matches": total_matches}


def compute_loi_baseline_wpm(bat_cache: dict, bowl_cache: dict) -> float:
    """Mean wpm across ALL LOI players (including non-bowlers as 0)."""
    wpms = []
    for pid in bat_cache:
        bat_df = bat_cache[pid]
        bat_clean = _prepare_bat_cum(bat_df)
        if len(bat_clean) < 2:
            continue
        total_mat = float(bat_clean.iloc[-1]["Mat"])
        if total_mat < LOI_MIN_MATCHES:
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
    bat_cache: dict, bowl_cache: dict, baseline_wpm: float = 1.0
) -> float:
    """Compute BoEI normalization scale for LOI formats."""
    bat_num = bat_den = bowl_num = bowl_den = 0.0
    for pid in bat_cache:
        try:
            bat_df = bat_cache[pid]
            bat_clean = _prepare_bat_cum(bat_df)
            if len(bat_clean) < 2 or float(bat_clean.iloc[-1]["Mat"]) < LOI_MIN_MATCHES:
                continue
            bowl_df = bowl_cache.get(pid)
            bat_stints, bowl_stints = compute_stints_loi(bat_df, bowl_df)
            for s in bat_stints:
                if s["bat_metric"] is not None:
                    bat_num += s["bat_metric"] * s["matches"]
                    bat_den += s["matches"]
            for s in bowl_stints:
                if s["bowl_metric"] is not None and s["wpm"] is not None:
                    bowl_num += s["bowl_metric"] * np.sqrt(s["wpm"] / baseline_wpm) * s["matches"]
                    bowl_den += s["matches"]
        except Exception:
            continue
    if bowl_den == 0 or bat_den == 0:
        return 1.0
    return (bat_num / bat_den) / (bowl_num / bowl_den)


def _scrape_loi_era_aggregate(
    start_year: int, end_year: int, cricket_class: int = 2
) -> dict | None:
    """Scrape overall LOI figures (Runs, Wkts, Ave, RPO) for a date range."""
    url = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class={cricket_class};spanmin1=01+Jan+{start_year};spanmax1=31+Dec+{end_year};"
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
        result = _scrape_loi_era_aggregate(sy, ey, cricket_class)
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


def compute_loi_all_players(
    bat_cache: dict,
    bowl_cache: dict,
    player_info: pd.DataFrame,
    boei_scale: float,
    baseline_wpm: float = 1.0,
    era_cache: dict | None = None,
    all_time_avg: float = 31.0,
    all_time_rpo: float = 4.7,
) -> list[dict]:
    span_map = {}
    if "Span" in player_info.columns:
        for _, row in player_info.iterrows():
            sp = parse_span(str(row.get("Span", "")))
            if sp:
                span_map[int(row["player_id"])] = sp

    records = []
    for pid in bat_cache:
        try:
            bat_df = bat_cache[pid]
            bowl_df = bowl_cache.get(pid)
            name = bat_df.attrs.get("player_name", "Unknown")

            bat_stints, bowl_stints = compute_stints_loi(bat_df, bowl_df)
            bat_clean = _prepare_bat_cum(bat_df)
            if len(bat_clean) < 2:
                continue
            total_matches = int(bat_clean.iloc[-1]["Mat"])
            if total_matches < LOI_MIN_MATCHES:
                continue

            idx = excellence_indices_loi(bat_stints, bowl_stints, total_matches, boei_scale, baseline_wpm)

            info_row = player_info[player_info["player_id"] == pid]
            country = info_row["country"].values[0] if len(info_row) > 0 else ""

            bei = idx["BEI"]
            boei = idx["BoEI"]
            era_avg = all_time_avg
            era_rpo = all_time_rpo
            bat_era_factor = 1.0
            bowl_era_factor = 1.0

            span = span_map.get(int(pid))
            if span and era_cache and span in era_cache:
                era_data = era_cache[span]
                era_avg = era_data["ave"]
                era_rpo = era_data["rpo"]
                if era_avg > 0 and era_rpo > 0:
                    bat_avg_factor = all_time_avg / era_avg
                    bat_sr_factor = all_time_rpo / era_rpo
                    bat_era_factor = round(bat_avg_factor * bat_sr_factor, 4)
                    bowl_avg_factor = era_avg / all_time_avg
                    bowl_rpo_factor = era_rpo / all_time_rpo
                    bowl_era_factor = round(bowl_avg_factor * bowl_rpo_factor, 4)
                    bei = round(bei * bat_era_factor, 2)
                    boei = round(boei * bowl_era_factor, 2)

            aei = round(bei + boei, 2)
            records.append({
                "player_id": int(pid),
                "player_name": name,
                "country": country,
                "BEI": bei,
                "BoEI": boei,
                "AEI": aei,
                "matches": total_matches,
                "bat_stints": bat_stints,
                "bowl_stints": bowl_stints,
                "era_avg": era_avg,
                "era_rpo": era_rpo,
                "bat_era_factor": bat_era_factor,
                "bowl_era_factor": bowl_era_factor,
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
) -> dict:
    """Build rankings JSON for an LOI format. Same structure as Test rankings."""
    rating_stats = compute_ratings(all_players)

    fm_players = [p for p in all_players if is_full_member(p["country"])]
    bei_sorted = sorted(fm_players, key=lambda p: p["BEI"], reverse=True)
    boei_sorted = sorted(fm_players, key=lambda p: p["BoEI"], reverse=True)

    allrounders = []
    for p in fm_players:
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
            "era_avg": p.get("era_avg"),
            "era_rpo": p.get("era_rpo"),
            "bat_era_factor": p.get("bat_era_factor"),
            "bowl_era_factor": p.get("bowl_era_factor"),
        }
        for p in all_players
    ]

    return {
        "metadata": {
            "format": format_name,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "total_players": len(all_players),
            "boei_scale": round(boei_scale, 4),
            "alpha": LOI_ALPHA,
            "bowl_k": BOWL_K,
            "min_matches": LOI_MIN_MATCHES,
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
    era_cache_path: Path = ODI_ERA_CACHE_PATH,
    force_scrape: bool = False,
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
        bat_agg = scrape_statsguru_aggregate("batting", min_matches=LOI_MIN_MATCHES, cricket_class=cricket_class)
        bat_agg.to_pickle(bat_agg_path)
        print(f"  Saved {len(bat_agg)} players")

    if bowl_agg_path.exists() and not force_scrape:
        bowl_agg = pd.read_pickle(bowl_agg_path)
        print(f"Loaded cached {format_name} bowling aggregate: {len(bowl_agg)} players")
    else:
        print(f"Scraping {format_name} bowling aggregate...")
        bowl_agg = scrape_statsguru_aggregate("bowling", min_matches=LOI_MIN_MATCHES, cricket_class=cricket_class)
        bowl_agg.to_pickle(bowl_agg_path)
        print(f"  Saved {len(bowl_agg)} players")

    all_ids = sorted(set(bat_agg["player_id"].tolist()) | set(bowl_agg["player_id"].tolist()))
    print(f"\nUnique {format_name} players with {LOI_MIN_MATCHES}+ matches: {len(all_ids)}")

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

    # 2. Per-player cumulative data
    if force_scrape or not bat_cum_path.exists():
        bat_cache, bowl_cache = scrape_loi_all_players(
            all_ids, cricket_class, bat_cum_path, bowl_cum_path
        )
    else:
        bat_cache = _load_loi_cache(bat_cum_path)
        bowl_cache = _load_loi_cache(bowl_cum_path)
        missing = [pid for pid in all_ids if pid not in bat_cache]
        if missing:
            print(f"  {len(missing)} new players to scrape...")
            bat_cache, bowl_cache = scrape_loi_all_players(
                all_ids, cricket_class, bat_cum_path, bowl_cum_path
            )
        else:
            print(f"  LOI cumulative cache: {len(bat_cache)} bat, {len(bowl_cache)} bowl")

    # 3. Era normalization
    print(f"\nScraping {format_name} era averages...")
    unique_spans = set()
    if "Span" in player_info.columns:
        for sp_str in player_info["Span"].dropna().unique():
            sp = parse_span(str(sp_str))
            if sp:
                unique_spans.add(sp)
    if unique_spans:
        min_y = min(s[0] for s in unique_spans)
        max_y = max(s[1] for s in unique_spans)
        unique_spans.add((min_y, max_y))

    if force_scrape or not era_cache_path.exists():
        era_cache = scrape_loi_era_averages(unique_spans, cricket_class, era_cache_path)
    else:
        era_cache = _load_loi_cache(era_cache_path)
        missing = unique_spans - set(era_cache.keys())
        if missing:
            era_cache = scrape_loi_era_averages(unique_spans, cricket_class, era_cache_path)
        else:
            print(f"  LOI era cache complete: {len(era_cache)} spans")

    all_time_avg, all_time_rpo = compute_loi_all_time(era_cache)
    print(f"  All-time {format_name} avg: {all_time_avg}, RPO: {all_time_rpo}")

    # 4. Baseline WPM and BoEI scale
    print(f"\nComputing {format_name} baseline wpm...")
    baseline_wpm = compute_loi_baseline_wpm(bat_cache, bowl_cache)
    print(f"  BASELINE_WPM = {baseline_wpm:.2f}")

    print(f"Computing {format_name} BoEI scale...")
    boei_scale = compute_loi_boei_scale(bat_cache, bowl_cache, baseline_wpm)
    print(f"  BOEI_SCALE = {boei_scale:.4f}")

    # 5. Compute all players
    print(f"Computing {format_name} indices for all players...")
    all_players = compute_loi_all_players(
        bat_cache, bowl_cache, player_info, boei_scale,
        baseline_wpm=baseline_wpm, era_cache=era_cache,
        all_time_avg=all_time_avg, all_time_rpo=all_time_rpo,
    )
    print(f"  Computed indices for {len(all_players)} players")

    # 6. Build JSON
    print(f"Building {format_name} rankings JSON...")
    rankings = build_loi_rankings_json(
        all_players, boei_scale,
        baseline_wpm=baseline_wpm, all_time_avg=all_time_avg,
        all_time_rpo=all_time_rpo, format_name=format_name,
    )

    return rankings


# ─── JSON Output ─────────────────────────────────────────────────────────────


def _z_to_rating(z: float) -> int:
    if z >= 0:
        return max(0, int(round(RATING_BASE + RATING_K * np.sqrt(z))))
    return max(0, int(round(RATING_BASE - RATING_K * np.sqrt(-z))))


def compute_ratings(all_players: list[dict]) -> dict:
    """Two-pass rating computation.

    Pass 1: compute BEI / BoEI ratings for every player.
    Pass 2: identify allrounders (min rating in both >= MIN_AR_RATING),
            compute AEI stats from that population, then assign AEI ratings.
    """
    bei_vals = np.array([p["BEI"] for p in all_players if p["BEI"] > 0])
    boei_vals = np.array([p["BoEI"] for p in all_players if p["BoEI"] > 0])

    stats = {
        "BEI": (float(bei_vals.mean()), float(bei_vals.std())),
        "BoEI": (float(boei_vals.mean()), float(boei_vals.std())),
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
    stats["AEI"] = (float(aei_vals.mean()), float(aei_vals.std())) if len(aei_vals) > 1 else (0.0, 1.0)

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


def build_rankings_json(all_players: list[dict], boei_scale: float, median_wpm: float = 2.75, all_time_avg: float = 31.91) -> dict:
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
        }
        if extra_fields:
            for k in extra_fields:
                d[k] = p[k]
        return d

    bei_vals = [p["BEI"] for p in all_players if p["BEI"] > 0]
    boei_vals = [p["BoEI"] for p in all_players if p["BoEI"] > 0]
    aei_vals = [p["AEI"] for p in all_players if p["AEI"] > 0]

    def percentiles(vals):
        if len(vals) < 5:
            return {}
        arr = np.array(vals)
        return {
            "p50": round(float(np.percentile(arr, 50)), 1),
            "p75": round(float(np.percentile(arr, 75)), 1),
            "p90": round(float(np.percentile(arr, 90)), 1),
            "p95": round(float(np.percentile(arr, 95)), 1),
            "p99": round(float(np.percentile(arr, 99)), 1),
            "max": round(float(arr.max()), 1),
        }

    def kde_points(vals, n_points=200):
        if len(vals) < 5:
            return {"x": [], "y": []}
        arr = np.array(vals)
        kde = gaussian_kde(arr, bw_method=0.3)
        x = np.linspace(0, np.percentile(arr, 99.5) * 1.1, n_points)
        y = kde(x)
        return {
            "x": [round(float(v), 2) for v in x],
            "y": [round(float(v), 6) for v in y],
        }

    # Alpha sensitivity: top 15 for each alpha
    alpha_comparison = {}
    for a in [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0]:
        recomputed = []
        for p in all_players:
            total = p["matches"]
            denom = total ** a if total > 0 else 1.0
            raw_bei = sum(
                s["bat_avg"] * s["matches"]
                for s in p["stints"] if s["bat_avg"] is not None
            )
            raw_boei = sum(
                s["bowl_score"] * np.sqrt(s["wpm"] / median_wpm) * s["matches"]
                for s in p["stints"] if s["bowl_score"] is not None and s["wpm"] is not None
            )
            bei = raw_bei / denom
            boei = raw_boei * boei_scale / denom
            bei *= p.get("bat_era_factor", 1.0)
            boei *= p.get("bowl_era_factor", 1.0)
            aei = bei + boei
            recomputed.append({
                "name": p["player_name"],
                "BEI": round(bei, 1),
                "BoEI": round(boei, 1),
                "AEI": round(aei, 1),
                "matches": total,
            })

        # Compute BEI/BoEI ratings via z-scores
        for metric in ["BEI", "BoEI"]:
            vals = [r[metric] for r in recomputed if r[metric] > 0]
            if len(vals) < 2:
                continue
            mu, sigma = float(np.mean(vals)), float(np.std(vals))
            if sigma == 0:
                sigma = 1.0
            for r in recomputed:
                v = r[metric]
                if v > 0:
                    z = (v - mu) / sigma
                    r[f"{metric}_rating"] = _z_to_rating(z)
                else:
                    r[f"{metric}_rating"] = 0

        # AEI ratings via z-scores against full population
        aei_v = [r["AEI"] for r in recomputed if r["AEI"] > 0]
        if len(aei_v) >= 2:
            a_mu, a_sigma = float(np.mean(aei_v)), float(np.std(aei_v))
            if a_sigma == 0:
                a_sigma = 1.0
            for r in recomputed:
                if r["AEI"] > 0:
                    r["AEI_rating"] = _z_to_rating((r["AEI"] - a_mu) / a_sigma)
                else:
                    r["AEI_rating"] = 0

        ar_qual = []
        for r in recomputed:
            if r.get("BEI_rating", 0) >= MIN_AR_RATING and r.get("BoEI_rating", 0) >= MIN_AR_RATING:
                r["geo_rating"] = round(np.sqrt(r["BEI_rating"] * r["BoEI_rating"]))
                ar_qual.append(r)

        bat_top = sorted(recomputed, key=lambda x: x["BEI"], reverse=True)[:15]
        bowl_top = sorted(recomputed, key=lambda x: x["BoEI"], reverse=True)[:15]
        ar_top = sorted(ar_qual, key=lambda x: x["geo_rating"], reverse=True)[:15]

        alpha_comparison[str(a)] = {
            "batting": bat_top,
            "bowling": bowl_top,
            "allrounder": ar_top,
        }

    # Compute global ranks for every player
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
            "era_avg": p.get("era_avg"),
            "bat_era_factor": p.get("bat_era_factor"),
            "bowl_era_factor": p.get("bowl_era_factor"),
        }
        for p in all_players
    ]

    return {
        "metadata": {
            "format": "Tests",
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "total_players": len(all_players),
            "boei_scale": round(boei_scale, 4),
            "alpha": ALPHA,
            "bowl_k": BOWL_K,
            "min_stint_bat_inn": MIN_STINT_BAT_INN,
            "min_stint_bowl_inn": MIN_STINT_BOWL_INN,
            "min_ar_rating": MIN_AR_RATING,
            "stint_size": STINT_SIZE,
            "rating_base": RATING_BASE,
            "rating_k": RATING_K,
            "all_time_avg": round(all_time_avg, 2),
        },
        "batting_top25": [player_summary(p) for p in bei_sorted[:TOP_N]],
        "bowling_top25": [player_summary(p) for p in boei_sorted[:TOP_N]],
        "allrounder_top25": [player_summary(p, ["balance"]) for p in allrounders[:TOP_N]],
        "distributions": {
            "BEI": {"percentiles": percentiles(bei_vals), "kde": kde_points(bei_vals)},
            "BoEI": {"percentiles": percentiles(boei_vals), "kde": kde_points(boei_vals)},
            "AEI": {"percentiles": percentiles(aei_vals), "kde": kde_points(aei_vals)},
        },
        "alpha_comparison": alpha_comparison,
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

    # Era normalization
    print("\nScraping era averages...")
    unique_spans = set()
    if "Span" in player_info.columns:
        for sp_str in player_info["Span"].dropna().unique():
            sp = parse_span(str(sp_str))
            if sp:
                unique_spans.add(sp)
    # Always include the broadest range for all-time average
    if unique_spans:
        min_y = min(s[0] for s in unique_spans)
        max_y = max(s[1] for s in unique_spans)
        unique_spans.add((min_y, max_y))

    if do_scrape or not ERA_CACHE_PATH.exists():
        era_cache = scrape_era_averages(unique_spans, delay=0.3)
    else:
        era_cache = load_era_cache()
        missing = unique_spans - set(era_cache.keys())
        if missing:
            print(f"  {len(missing)} new spans to scrape...")
            era_cache = scrape_era_averages(unique_spans, delay=0.3)
        else:
            print(f"  Era cache complete: {len(era_cache)} spans")

    all_time_avg = compute_all_time_avg(era_cache)
    print(f"  All-time Test average: {all_time_avg}")

    print("\nComputing baseline wickets per match (all players)...")
    median_wpm = compute_baseline_wpm(cache)
    print(f"  BASELINE_WPM = {median_wpm:.2f}")

    print("Computing BoEI normalization scale...")
    boei_scale = compute_boei_scale(cache, innings_cache, median_wpm)
    print(f"  BOEI_SCALE = {boei_scale:.4f}")

    print("Computing indices for all players (with era adjustment)...")
    all_players = compute_all_players(
        cache, innings_cache, player_info, boei_scale,
        median_wpm=median_wpm, era_cache=era_cache, all_time_avg=all_time_avg,
    )
    print(f"  Computed indices for {len(all_players)} players")

    print("Building Test rankings JSON...")
    rankings = build_rankings_json(all_players, boei_scale, median_wpm=median_wpm, all_time_avg=all_time_avg)

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
        era_cache_path=ODI_ERA_CACHE_PATH,
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

    print("\nDone!")


if __name__ == "__main__":
    main()
