#!/usr/bin/env python3
"""Patch all JSON data files with playing_role using curated mapping + heuristics."""
import json
from pathlib import Path

ROLE_MAP = {
    # ── Openers ──
    "SM Gavaskar": "opener", "G Boycott": "opener", "L Hutton": "opener",
    "JB Hobbs": "opener", "H Sutcliffe": "opener",
    "CG Greenidge": "opener", "DL Haynes": "opener",
    "MA Taylor": "opener", "ML Hayden": "opener", "JL Langer": "opener",
    "V Sehwag": "opener", "HM Amla": "opener", "DA Warner": "opener",
    "AN Cook": "opener", "ME Trescothick": "opener", "AJ Strauss": "opener",
    "WM Lawry": "opener", "RB Simpson": "opener", "GM Turner": "opener",
    "MP Vaughan": "opener",
    "Saeed Anwar": "opener", "ST Jayasuriya": "opener",
    "TM Dilshan": "opener", "Tamim Iqbal": "opener",
    "RG Sharma": "opener", "S Dhawan": "opener", "MJ Guptill": "opener",
    "Fakhar Zaman": "opener", "Imam-ul-Haq": "opener",
    "Q de Kock": "opener", "BB McCullum": "opener",
    "WU Tharanga": "opener", "FDM Karunaratne": "opener",
    "G Kirsten": "opener", "G Gambhir": "opener",
    "KC Brathwaite": "opener", "KR Karunaratne": "opener",
    "YBK Jaiswal": "opener", "PD Salt": "opener",
    "PP Shaw": "opener", "D Padikkal": "opener",
    "RD Gaikwad": "opener", "DJ Mitchell": "opener",
    "CH Gayle": "opener", "Babar Azam": "opener",

    # ── Middle Order ──
    "SR Tendulkar": "middle", "JE Root": "middle", "RT Ponting": "middle",
    "R Dravid": "middle", "BC Lara": "middle", "S Chanderpaul": "middle",
    "AB de Villiers": "middle", "SPD Smith": "middle", "KS Williamson": "middle",
    "V Kohli": "middle", "Younis Khan": "middle", "Javed Miandad": "middle",
    "Inzamam-ul-Haq": "middle", "VVS Laxman": "middle", "MJ Clarke": "middle",
    "KP Pietersen": "middle", "ME Waugh": "middle", "SR Waugh": "middle",
    "AR Border": "middle", "IVA Richards": "middle", "DI Gower": "middle",
    "AD Mathews": "middle", "MA Atherton": "middle", "IR Bell": "middle",
    "LRPL Taylor": "middle", "MC Cowdrey": "middle", "GC Smith": "middle",
    "Mohammad Yousuf": "middle", "DC Boon": "middle", "CA Pujara": "middle",
    "MEK Hussey": "middle", "MJ Crowe": "middle", "DM Jones": "middle",
    "Azhar Ali": "middle", "Misbah-ul-Haq": "middle", "SP Fleming": "middle",
    "M Labuschagne": "middle", "T Head": "middle", "GS Chappell": "middle",
    "KC Sangakkara": "middle", "DPMD Jayawardene": "middle",
    "Faf du Plessis": "middle", "HE van der Dussen": "middle",
    "SS Iyer": "middle", "SA Yadav": "middle", "DA Miller": "middle",
    "GJ Maxwell": "middle", "N Pooran": "middle", "SK Raina": "middle",
    "Mushfiqur Rahim": "middle", "KD Karthik": "middle",
    "ED Weekes": "middle", "CL Walcott": "middle", "FMM Worrell": "middle",
    "KF Barrington": "middle", "DG Bradman": "middle",
    "WR Hammond": "middle", "GR Viswanath": "middle",

    # ── Wicketkeeper-Batsmen ──
    "AC Gilchrist": "keeper", "MS Dhoni": "keeper", "A Flower": "keeper",
    "MV Boucher": "keeper", "BJ Watling": "keeper", "RD Jacobs": "keeper",
    "TD Paine": "keeper", "BJ Haddin": "keeper", "Kamran Akmal": "keeper",
    "IA Healy": "keeper", "RW Marsh": "keeper", "APE Knott": "keeper",
    "SMH Kirmani": "keeper", "JC Buttler": "keeper", "JM Bairstow": "keeper",
    "RR Pant": "keeper", "KL Rahul": "keeper", "SV Samson": "keeper",
    "RV Uthappa": "keeper", "MS Wade": "keeper", "Liton Das": "keeper",
    "N Dickwella": "keeper", "KS Bharat": "keeper",

    # ── Allrounders ──
    "GS Sobers": "allrounder", "JH Kallis": "allrounder", "Imran Khan": "allrounder",
    "IT Botham": "allrounder", "KR Miller": "allrounder", "BA Stokes": "allrounder",
    "Shakib Al Hasan": "allrounder", "A Flintoff": "allrounder",
    "CL Cairns": "allrounder", "CR Woakes": "allrounder",
    "Shahid Afridi": "allrounder", "Abdul Razzaq": "allrounder",
    "L Klusener": "allrounder", "SR Watson": "allrounder",
    "HH Pandya": "allrounder", "JP Faulkner": "allrounder",
    "MH Mankad": "allrounder", "CL Hooper": "allrounder",
    "Mohammad Hafeez": "allrounder", "Mahmudullah": "allrounder",
    "AD Russell": "allrounder", "DJ Bravo": "allrounder",
    "M Marsh": "allrounder", "AR Patel": "allrounder",
    "TP Curran": "allrounder",

    # ── Spinners ──
    "M Muralidaran": "spinner", "SK Warne": "spinner", "A Kumble": "spinner",
    "R Ashwin": "spinner", "RA Jadeja": "spinner", "Saqlain Mushtaq": "spinner",
    "DL Vettori": "spinner", "Harbhajan Singh": "spinner",
    "BS Bedi": "spinner", "EAS Prasanna": "spinner", "BS Chandrasekhar": "spinner",
    "Mushtaq Ahmed": "spinner", "Danish Kaneria": "spinner",
    "HMRKB Herath": "spinner", "Yasir Shah": "spinner", "N Lyon": "spinner",
    "GP Swann": "spinner", "SP Narine": "spinner", "Rashid Khan": "spinner",
    "YS Chahal": "spinner", "Kuldeep Yadav": "spinner",
    "Adil Rashid": "spinner", "AU Rashid": "spinner", "IS Sodhi": "spinner",
    "MJ Santner": "spinner", "Wanindu Hasaranga": "spinner",
    "Varun Chakravarthy": "spinner", "R Bishnoi": "spinner",
    "PP Chawla": "spinner", "Amit Mishra": "spinner",
    "Imad Wasim": "spinner", "Abdur Razzak": "spinner",
    "S Venkataraghavan": "spinner",

    # ── Fast Bowlers (Tests / historic) ──
    "SF Barnes": "fast", "Sir RJ Hadlee": "fast", "RJ Hadlee": "fast",
    "FS Trueman": "fast", "JB Statham": "fast", "AV Bedser": "fast",
    "RR Lindwall": "fast", "KR Miller": "fast",
    "AK Davidson": "fast", "WJ O'Reilly": "fast",
    "CEL Stuart": "fast", "ITE Bailey": "fast",
    "EAS Prasanna": "spinner", "BS Bedi": "spinner",
    "CV Grimmett": "spinner", "WJ O'Reilly": "spinner",
    "SF Barnes": "fast",

    # ── Fast Bowlers ──
    "GD McGrath": "fast", "Wasim Akram": "fast", "Waqar Younis": "fast",
    "CEL Ambrose": "fast", "CA Walsh": "fast", "DK Lillee": "fast",
    "MD Marshall": "fast", "J Garner": "fast", "AA Donald": "fast",
    "SM Pollock": "fast", "DW Steyn": "fast", "B Lee": "fast",
    "WPUJC Vaas": "fast", "Zaheer Khan": "fast",
    "JM Anderson": "fast", "SCJ Broad": "fast", "MA Starc": "fast",
    "JR Hazlewood": "fast", "TG Southee": "fast", "PJ Cummins": "fast",
    "Shoaib Akhtar": "fast", "M Morkel": "fast", "VD Philander": "fast",
    "TA Boult": "fast", "K Rabada": "fast", "JJ Bumrah": "fast",
    "RJ Hadlee": "fast", "Mohammad Asif": "fast", "Umar Gul": "fast",
    "SL Malinga": "fast", "MG Johnson": "fast", "Mustafizur Rahman": "fast",
    "Shaheen Shah Afridi": "fast", "Haris Rauf": "fast", "Hasan Ali": "fast",
    "A Nortje": "fast", "L Ngidi": "fast", "Mohammad Amir": "fast",
    "Arshdeep Singh": "fast", "Mohammed Siraj": "fast",
    "M Shami": "fast", "Bhuvneshwar Kumar": "fast", "UT Yadav": "fast",
    "DL Chahar": "fast", "JC Archer": "fast", "JR Thomson": "fast",
    "JDP Oram": "fast", "RJ Harris": "fast",
    "T Natarajan": "fast", "Avesh Khan": "fast", "JD Unadkat": "fast",
}


def heuristic_role(player):
    """Fallback role assignment based on available stats."""
    bat_r = player.get("bat_rating", 0) or 0
    bowl_r = player.get("bowl_rating", 0) or 0

    is_genuine_allrounder = (bat_r >= 500 and bowl_r >= 500 and
                             abs(bat_r - bowl_r) < 300)
    if is_genuine_allrounder:
        return "allrounder"
    if bowl_r > bat_r:
        return "fast"
    if bat_r > 0:
        return "middle"
    return None


def patch_json(json_path):
    with open(json_path) as f:
        data = json.load(f)

    name_role = {}
    for pl in data.get("all_players", []):
        name = pl.get("name", "")
        role = ROLE_MAP.get(name) or heuristic_role(pl)
        if role:
            name_role[name] = role

    patched = 0
    for list_key in ["all_players", "batting_top25", "bowling_top25", "allrounder_top25"]:
        for pl in data.get(list_key, []):
            name = pl.get("name") or pl.get("player_name", "")
            role = ROLE_MAP.get(name) or name_role.get(name) or heuristic_role(pl)
            if role:
                pl["playing_role"] = role
                patched += 1

    with open(json_path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"  {json_path}: patched {patched} entries", flush=True)


def main():
    for jpath in ["docs/rankings.json", "docs/odi_rankings.json", "docs/t20i_rankings.json", "docs/ipl_rankings.json"]:
        if Path(jpath).exists():
            patch_json(jpath)
        else:
            print(f"  {jpath}: not found", flush=True)
    print("Done!", flush=True)


if __name__ == "__main__":
    main()
