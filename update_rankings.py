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
MIN_MATCHES = 20
STINT_SIZE = 10
TOP_N = 100
RATING_BASE = 350
RATING_K = 351  # sqrt-compressed: 900+=elite, 800+=great, 700+=very good
MIN_AR_RATING = 250  # min rating in both bat & bowl to qualify as allrounder

CACHE_DIR = Path(__file__).parent / "cricket_cache"
CACHE_DIR.mkdir(exist_ok=True)
SITE_DIR = Path(__file__).parent / "docs"
SITE_DIR.mkdir(exist_ok=True)

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

BAT_AGG_PATH = CACHE_DIR / "batting_aggregate.pkl"
BOWL_AGG_PATH = CACHE_DIR / "bowling_aggregate.pkl"
ALLROUND_CACHE_PATH = CACHE_DIR / "allround_cache.pkl"
INNINGS_CACHE_PATH = CACHE_DIR / "innings_cache.pkl"

# ─── Scraping ────────────────────────────────────────────────────────────────


def _parse_player_country(name_str: str) -> tuple[str, str]:
    m = re.match(r"^(.+?)\(([^)]+)\)$", name_str.strip())
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return name_str.strip(), ""


def scrape_statsguru_aggregate(
    stat_type: str = "batting", min_matches: int = 20, page_size: int = 200
) -> pd.DataFrame:
    base = (
        f"https://stats.espncricinfo.com/ci/engine/stats/index.html?"
        f"class=1;template=results;type={stat_type};"
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

        stints.append({
            "label": f"{int(df.iloc[i]['Mat'])}\u2013{int(c['Mat'])}",
            "matches": matches,
            "bat_avg": round(bat_avg, 2) if bat_avg is not None else None,
            "bowl_avg": round(bowl_avg, 2) if bowl_avg is not None else None,
            "bowl_score": round(bowl_score, 2) if bowl_score is not None else None,
        })
        i = end_idx + 1

    return stints


def excellence_indices(stints: list[dict], boei_scale: float = 1.0) -> dict:
    total_matches = sum(s["matches"] for s in stints)
    denom = total_matches ** ALPHA if total_matches > 0 else 1.0

    bat_sum = sum(
        s["bat_avg"] * s["matches"] for s in stints if s["bat_avg"] is not None
    )
    bowl_sum = sum(
        s["bowl_score"] * s["matches"] for s in stints if s["bowl_score"] is not None
    )

    bei = bat_sum / denom
    boei = bowl_sum * boei_scale / denom
    aei = bei + boei

    return {"BEI": round(bei, 2), "BoEI": round(boei, 2), "AEI": round(aei, 2), "matches": total_matches}


def compute_boei_scale(cache: dict, innings_cache: dict) -> float:
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
                if s["bowl_score"] is not None:
                    bowl_num += s["bowl_score"] * s["matches"]
                    bowl_den += s["matches"]
        except Exception:
            continue
    if bowl_den == 0 or bat_den == 0:
        return 1.0
    return (bat_num / bat_den) / (bowl_num / bowl_den)


def compute_all_players(cache: dict, innings_cache: dict, player_info: pd.DataFrame, boei_scale: float):
    records = []
    for pid, df in cache.items():
        try:
            name = df.attrs.get("player_name", "Unknown")
            df_clean = df.dropna(subset=["Mat"])
            if len(df_clean) < 2:
                continue
            inn_data = innings_cache.get(pid)
            stints = compute_stints(df_clean, inn_data)
            idx = excellence_indices(stints, boei_scale)
            info_row = player_info[player_info["player_id"] == pid]
            country = info_row["country"].values[0] if len(info_row) > 0 else ""
            records.append({
                "player_id": int(pid),
                "player_name": name,
                "country": country,
                "BEI": idx["BEI"],
                "BoEI": idx["BoEI"],
                "AEI": idx["AEI"],
                "matches": idx["matches"],
                "stints": stints,
            })
        except Exception:
            continue

    records.sort(key=lambda r: r["AEI"], reverse=True)
    return records


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

    # Pass 2: AEI ratings — geometric mean of individual ratings,
    # normalized so the best allrounder ≈ 1000.
    # z-scores don't work here because the allrounder population is too
    # small (~40-50) and heavily right-skewed.
    qualifying = [
        p for p in all_players
        if p["BEI_rating"] >= MIN_AR_RATING
        and p["BoEI_rating"] >= MIN_AR_RATING
    ]
    for p in qualifying:
        p["_ar_geo"] = np.sqrt(p["BEI_rating"] * p["BoEI_rating"])

    max_geo = max((p["_ar_geo"] for p in qualifying), default=1)
    for p in all_players:
        geo = p.pop("_ar_geo", 0)
        if geo > 0:
            p["AEI_rating"] = int(round(geo / max_geo * 1000))
        else:
            p["AEI_rating"] = 0

    stats["AEI"] = (0.0, 0.0)  # not used for z-scores anymore
    return stats


def build_rankings_json(all_players: list[dict], boei_scale: float) -> dict:
    rating_stats = compute_ratings(all_players)

    bei_sorted = sorted(all_players, key=lambda p: p["BEI"], reverse=True)
    boei_sorted = sorted(all_players, key=lambda p: p["BoEI"], reverse=True)

    allrounders = []
    for p in all_players:
        if p["AEI_rating"] <= 0:
            continue
        if p["BEI_rating"] >= MIN_AR_RATING and p["BoEI_rating"] >= MIN_AR_RATING:
            balance = min(p["BEI"], p["BoEI"]) / p["AEI"] if p["AEI"] > 0 else 0
            allrounders.append({**p, "balance": round(balance * 100, 1)})
    allrounders.sort(key=lambda p: p["AEI_rating"], reverse=True)

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
            "ar_rating": p["AEI_rating"],
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
                s["bowl_score"] * s["matches"]
                for s in p["stints"] if s["bowl_score"] is not None
            )
            bei = raw_bei / denom
            boei = raw_boei * boei_scale / denom
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

        # AEI ratings via geometric mean of individual ratings
        ar_qual = [
            r for r in recomputed
            if r.get("BEI_rating", 0) >= MIN_AR_RATING
            and r.get("BoEI_rating", 0) >= MIN_AR_RATING
        ]
        for r in ar_qual:
            r["_ar_geo"] = np.sqrt(r["BEI_rating"] * r["BoEI_rating"])
        a_max_geo = max((r["_ar_geo"] for r in ar_qual), default=1)
        for r in recomputed:
            if "_ar_geo" in r and r["_ar_geo"] > 0:
                r["AEI_rating"] = int(round(r["_ar_geo"] / a_max_geo * 1000))
            else:
                r["AEI_rating"] = 0

        bat_top = sorted(recomputed, key=lambda x: x["BEI"], reverse=True)[:15]
        bowl_top = sorted(recomputed, key=lambda x: x["BoEI"], reverse=True)[:15]
        ar_top = sorted(ar_qual, key=lambda x: x["AEI_rating"], reverse=True)[:15]

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
    for rank, p in enumerate(allrounders, 1):
        ar_rank_map[p["player_name"]] = rank

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
            "ar_rating": p["AEI_rating"],
            "bat_rank": bat_rank_map.get(p["player_name"]),
            "bowl_rank": bowl_rank_map.get(p["player_name"]),
            "ar_rank": ar_rank_map.get(p["player_name"]),
            "stints": p["stints"],
        }
        for p in all_players
    ]

    return {
        "metadata": {
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

    player_info = bat_agg[["player_id", "player_name", "country"]].drop_duplicates("player_id")
    bowl_only = bowl_agg[~bowl_agg["player_id"].isin(player_info["player_id"])][
        ["player_id", "player_name", "country"]
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

    print("\nComputing BoEI normalization scale...")
    boei_scale = compute_boei_scale(cache, innings_cache)
    print(f"  BOEI_SCALE = {boei_scale:.4f}")

    print("Computing indices for all players...")
    all_players = compute_all_players(cache, innings_cache, player_info, boei_scale)
    print(f"  Computed indices for {len(all_players)} players")

    print("Building rankings JSON...")
    rankings = build_rankings_json(all_players, boei_scale)

    out_path = SITE_DIR / "rankings.json"
    with open(out_path, "w") as f:
        json.dump(rankings, f, separators=(",", ":"))

    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"\nWrote {out_path} ({size_mb:.1f} MB)")
    print(f"  Batting top 3: {', '.join(p['name'] for p in rankings['batting_top25'][:3])}")
    print(f"  Bowling top 3: {', '.join(p['name'] for p in rankings['bowling_top25'][:3])}")
    print(f"  Allrounder top 3: {', '.join(p['name'] for p in rankings['allrounder_top25'][:3])}")
    print("\nDone!")


if __name__ == "__main__":
    main()
