#!/usr/bin/env python3
"""Check if any player's rating now exceeds the incumbent in the curated default XI.

Run after update_rankings.py. If changes are found, creates a GitHub issue
for approval/rejection.
"""
import json, subprocess, sys
from pathlib import Path

SITE_DIR = Path("docs")
DEFAULT_XIS_PATH = SITE_DIR / "default_xis.json"

FORMAT_FILES = {
    "tests": SITE_DIR / "rankings.json",
    "odis": SITE_DIR / "odi_rankings.json",
    "t20is": SITE_DIR / "t20i_rankings.json",
    "ipl": SITE_DIR / "ipl_rankings.json",
}

ROLE_RATING_KEY = {
    "opener": "bat_rating",
    "middle": "bat_rating",
    "keeper": "bat_rating",
    "allrounder": "ar_rating",
    "spinner": "bowl_rating",
    "fast": "bowl_rating",
}


def effective_role(p):
    """Determine a player's XI role for comparison purposes."""
    r = p.get("playing_role", "")
    if r in ("opener", "middle", "keeper", "allrounder", "spinner", "fast"):
        return r
    bt = p.get("bowl_type", "")
    if bt in ("spinner", "fast"):
        return bt
    return r


def check_format(format_key, curated_names, data):
    """Compare curated XI against current ratings. Return list of proposed changes."""
    all_players = {p["name"]: p for p in data.get("all_players", [])}

    # Build qualified pool (same filter as app.js)
    qualified_names = set()
    for k in ("batting_top25", "bowling_top25", "allrounder_top25"):
        for p in data.get(k, []):
            qualified_names.add(p["name"])

    changes = []
    for slot_idx, incumbent_name in enumerate(curated_names):
        incumbent = all_players.get(incumbent_name)
        if not incumbent:
            continue

        role = effective_role(incumbent)
        rating_key = ROLE_RATING_KEY.get(role)
        if not rating_key:
            continue

        incumbent_rating = incumbent.get(rating_key, 0) or 0

        # Find all qualified players with the same role and higher rating
        for name in qualified_names:
            if name in curated_names:
                continue
            p = all_players.get(name)
            if not p:
                continue
            if effective_role(p) != role:
                continue
            p_rating = p.get(rating_key, 0) or 0
            if p_rating > incumbent_rating:
                changes.append({
                    "slot": slot_idx + 1,
                    "role": role,
                    "incumbent": incumbent_name,
                    "incumbent_rating": incumbent_rating,
                    "challenger": name,
                    "challenger_rating": p_rating,
                    "diff": p_rating - incumbent_rating,
                })

    return changes


def main():
    if not DEFAULT_XIS_PATH.exists():
        print("No default_xis.json found, skipping XI check.")
        return

    with open(DEFAULT_XIS_PATH) as f:
        curated = json.load(f)

    all_changes = {}
    for fmt, names in curated.items():
        if not names or len(names) < 11:
            continue
        data_path = FORMAT_FILES.get(fmt)
        if not data_path or not data_path.exists():
            continue
        with open(data_path) as f:
            data = json.load(f)

        changes = check_format(fmt, names, data)
        if changes:
            all_changes[fmt] = changes

    if not all_changes:
        print("No XI changes to propose.")
        return

    # Build issue body
    lines = ["The following players now have higher ratings than current XI incumbents:\n"]
    for fmt, changes in all_changes.items():
        lines.append(f"## {fmt.upper()}\n")
        # Group by role, show only the top challenger per slot
        seen_slots = set()
        for c in sorted(changes, key=lambda x: -x["diff"]):
            if c["slot"] in seen_slots:
                continue
            seen_slots.add(c["slot"])
            lines.append(
                f"- **Slot {c['slot']} ({c['role']})**: "
                f"**{c['challenger']}** ({c['challenger_rating']}) "
                f"overtakes {c['incumbent']} ({c['incumbent_rating']}) "
                f"[+{c['diff']}]"
            )
        lines.append("")

    lines.append("To approve a change, update `docs/default_xis.json` and commit.")
    body = "\n".join(lines)
    title = f"Potential Greatest XI changes ({len(all_changes)} format{'s' if len(all_changes) > 1 else ''})"

    print(f"\n{'='*60}")
    print(title)
    print("=" * 60)
    print(body)

    if "--create-issue" in sys.argv:
        try:
            subprocess.run(["gh", "label", "create", "xi-change", "--color", "FBCA04",
                            "--description", "Proposed Greatest XI change"], check=False,
                           capture_output=True)
            subprocess.run(
                ["gh", "issue", "create", "--title", title, "--body", body, "--label", "xi-change"],
                check=True,
            )
            print("\nGitHub issue created.")
        except FileNotFoundError:
            print("\ngh CLI not found — issue printed above, create manually.")
        except subprocess.CalledProcessError as e:
            print(f"\nFailed to create issue: {e}")
    else:
        print("\nRun with --create-issue to create a GitHub issue.")


if __name__ == "__main__":
    main()
