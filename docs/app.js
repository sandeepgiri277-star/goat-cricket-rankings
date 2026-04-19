/* ─── GOAT Cricket Rankings — Frontend ──────────────────────────────────── */

const ALL_DATA = {};
let DATA = null;
let CURRENT_FORMAT = 'tests';
let CROSS_FORMAT_DATA = null;

const FORMAT_FILES = {
  tests: 'rankings.json',
  odis: 'odi_rankings.json',
  t20is: 't20i_rankings.json',
  ipl: 'ipl_rankings.json',
};

const FORMAT_LABELS = {
  tests: 'Test',
  odis: 'ODI',
  t20is: 'T20I',
  ipl: 'IPL',
  crossformat: 'Cross-Format',
};

const COLORS = {
  bat: '#636EFA',
  bowl: '#00CC96',
  aei: '#EF553B',
  gold: '#FFD700',
  silver: '#C0C0C0',
  bronze: '#CD7F32',
};

const XF_COLORS = { tests: '#636EFA', odis: '#00CC96', t20is: '#EF553B' };
const XF_MIN_AR = 500;

const plotlyConfig = { responsive: true, displayModeBar: false };

const FULL_MEMBERS = new Set(['AUS','BAN','ENG','IND','IRE','NZ','PAK','SA','SL','WI','ZIM','AFG']);
function isFullMember(country) {
  if (!country) return false;
  return country.split('/').some(c => FULL_MEMBERS.has(c));
}

const TUNE_DEFAULTS = {
  batLongevity: 0.30, bowlLongevity: 0.30, batPitch: 0.50, bowlPitch: 0.50,
  alpha: 0.30, srWeight: 1.0, bowlSrWeight: 0.5, wpiWeight: 0.5, bowlAvgW: 1.0,
  bowlK: 1000, ratingK: 250,
  xfTests: 33, xfOdis: 33, xfT20is: 34,
};
const TUNE_RANGES = {
  batLongevity:  { min: 0, max: 0.6, step: 0.05 },
  bowlLongevity: { min: 0, max: 0.6, step: 0.05 },
  batPitch:      { min: 0, max: 1.0, step: 0.1 },
  bowlPitch:     { min: 0, max: 1.0, step: 0.1 },
  alpha:        { min: 0, max: 1.0, step: 0.05 },
  srWeight:     { min: 0, max: 2.0, step: 0.1 },
  bowlSrWeight: { min: 0, max: 1.0, step: 0.05 },
  wpiWeight:    { min: 0, max: 1.0, step: 0.05 },
  bowlAvgW:     { min: 0, max: 2.0, step: 0.1 },
  bowlK:        { min: 500, max: 2000, step: 100 },
  ratingK:      { min: 100, max: 500, step: 50 },
  xfTests:      { min: 0, max: 100, step: 1 },
  xfOdis:       { min: 0, max: 100, step: 1 },
  xfT20is:      { min: 0, max: 100, step: 1 },
};
function _sliderToReal(key, pct) {
  const r = TUNE_RANGES[key];
  const raw = r.min + (pct / 100) * (r.max - r.min);
  const decimals = (r.step.toString().split('.')[1] || '').length;
  return parseFloat((Math.round(raw / r.step) * r.step).toFixed(decimals));
}
function _realToSlider(key, val) {
  const r = TUNE_RANGES[key];
  return Math.round((val - r.min) / (r.max - r.min) * 100);
}
let TUNE_PARAMS = { ...TUNE_DEFAULTS };
let AR_TUNE_PARAMS = { ...TUNE_DEFAULTS };
let ORIGINAL_DATA = {};

function activeTab() {
  const el = document.querySelector('.tab.active');
  return el ? el.dataset.tab : 'allrounders';
}
function activeParams() {
  return activeTab() === 'allrounders' ? AR_TUNE_PARAMS : TUNE_PARAMS;
}

const XF_PARAM_KEYS = {
  tests: ['batLongevity', 'bowlLongevity', 'batPitch', 'bowlPitch', 'alpha', 'bowlSrWeight', 'bowlAvgW', 'wpiWeight'],
  odis:  ['batLongevity', 'bowlLongevity', 'batPitch', 'bowlPitch', 'alpha', 'srWeight', 'bowlSrWeight'],
  t20is: ['batLongevity', 'bowlLongevity', 'batPitch', 'bowlPitch', 'alpha', 'srWeight', 'bowlSrWeight'],
};
const XF_TUNE_DEFAULTS = {
  tests: { batLongevity: 0.30, bowlLongevity: 0.30, batPitch: 0.50, bowlPitch: 0.50, alpha: 0.30, bowlSrWeight: 0.5, bowlAvgW: 1.0, wpiWeight: 0.5 },
  odis:  { batLongevity: 0.30, bowlLongevity: 0.30, batPitch: 0.50, bowlPitch: 0.50, alpha: 0.30, srWeight: 1.0, bowlSrWeight: 0.5 },
  t20is: { batLongevity: 0.30, bowlLongevity: 0.30, batPitch: 0.50, bowlPitch: 0.50, alpha: 0.30, srWeight: 1.0, bowlSrWeight: 0.5 },
};
let XF_TUNE_PARAMS = JSON.parse(JSON.stringify(XF_TUNE_DEFAULTS));

function computeIndices(allPlayers, p, m, isLOI) {
  const boeiScale = m.boei_scale || 1;
  const baselineWpi = m.baseline_wpi || 1.46;
  const baselineSr = m.baseline_sr || 79.9;
  const srExp = m.sr_exp || 0.2;
  const minBowlInns = m.min_bowl_inns || m.stint_innings || 20;
  const ratingBase = m.rating_base || 500;

  const results = allPlayers.map(pl => {
    const avg = pl.career_bat_avg || 0;
    const rpi = pl.career_rpi || avg;
    const batInns = pl.bat_inns || 0;
    const sr = pl.career_bat_sr || 80;
    const batPf = pl.bat_pitch_factor || 1;

    let bei = 0;
    if (batInns > 0 && avg > 0) {
      const quality = Math.pow(avg, 1 - p.alpha) * Math.pow(rpi, p.alpha);
      bei = quality * Math.pow(batInns, p.batLongevity) * Math.pow(batPf, p.batPitch);
      if (isLOI) bei *= Math.pow(sr / 100, p.srWeight);
    }

    const bowlAvg = pl.career_bowl_avg || 0;
    const bowlInns = pl.bowl_inns || 0;
    const bowlPf = pl.bowl_pitch_factor || 1;
    const bowlSr = pl.career_bowl_sr || 0;
    const bowlEcon = pl.career_bowl_econ || 0;
    const wpi = pl.career_wpi || 0;
    const ballsBowled = pl.balls_bowled || 0;

    let boei = 0;
    if (bowlInns >= minBowlInns && bowlAvg > 0) {
      if (isLOI) {
        if (bowlSr > 0 && bowlEcon > 0) {
          const w = p.bowlSrWeight;
          const combo = Math.pow(bowlSr, 2 * w) * Math.pow(bowlEcon / 6, 2 * (1 - w));
          const longevityBase = ballsBowled > 0 ? ballsBowled : bowlInns;
          boei = p.bowlK / combo * Math.pow(longevityBase, p.bowlLongevity) * boeiScale;
        }
      } else {
        if (wpi > 0 && baselineWpi > 0) {
          const effSrExp = srExp * 2 * p.bowlSrWeight;
          const srFactor = (bowlSr > 0 && baselineSr > 0) ? Math.pow(baselineSr / bowlSr, effSrExp) : 1;
          boei = (p.bowlK / Math.pow(bowlAvg, p.bowlAvgW)) * Math.pow(wpi / baselineWpi, p.wpiWeight) * srFactor * Math.pow(bowlInns, p.bowlLongevity) * boeiScale;
        }
      }
      boei *= Math.pow(bowlPf, p.bowlPitch);
    }

    return { player: pl, bei: Math.round(bei * 100) / 100, boei: Math.round(boei * 100) / 100 };
  });

  const beiVals = results.map(r => r.bei);
  const boeiVals = results.filter(r => r.boei > 0).map(r => r.boei);

  function medianStd(arr) {
    if (arr.length === 0) return [0, 1];
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return [med, Math.sqrt(variance)];
  }

  const [beiMed, beiStd] = medianStd(beiVals);
  const [boeiMed, boeiStd] = medianStd(boeiVals);

  function toRating(val, med, std) {
    if (std === 0) return ratingBase;
    const z = (val - med) / std;
    return Math.round(z >= 0 ? ratingBase + p.ratingK * Math.sqrt(z) : ratingBase + p.ratingK * z);
  }

  for (const r of results) {
    r.bat_rating = r.bei > 0 ? toRating(r.bei, beiMed, beiStd) : 0;
    r.bowl_rating = r.boei > 0 ? toRating(r.boei, boeiMed, boeiStd) : 0;
  }

  return { results, beiMed, beiStd, boeiMed, boeiStd };
}

function recomputeRankings() {
  if (!DATA || CURRENT_FORMAT === 'crossformat') return;
  const m = DATA.metadata;
  const isLOI = CURRENT_FORMAT !== 'tests';
  const allPlayers = DATA.all_players;
  const minArRating = m.min_ar_rating || 250;
  const isFmOnly = CURRENT_FORMAT !== 'ipl';

  const { results, beiMed, beiStd, boeiMed, boeiStd } = computeIndices(allPlayers, TUNE_PARAMS, m, isLOI);
  for (const r of results) {
    r.player.BEI = r.bei;
    r.player.BoEI = r.boei;
    r.player.AEI = Math.round((r.bei + r.boei) * 100) / 100;
    r.player.bat_rating = r.bat_rating;
    r.player.bowl_rating = r.bowl_rating;
  }

  const ranked = isFmOnly ? allPlayers.filter(pl => isFullMember(pl.country)) : allPlayers;
  const batSorted = [...ranked].sort((a, b) => b.BEI - a.BEI);
  const bowlSorted = [...ranked].filter(pl => pl.BoEI > 0).sort((a, b) => b.BoEI - a.BoEI);
  batSorted.forEach((pl, i) => { pl.bat_rank = pl.BEI > 0 ? i + 1 : null; });
  bowlSorted.forEach((pl, i) => { pl.bowl_rank = pl.BoEI > 0 ? i + 1 : null; });

  DATA.batting_top25 = batSorted.slice(0, 100);
  DATA.bowling_top25 = bowlSorted.slice(0, 100);

  const arRes = computeIndices(allPlayers, AR_TUNE_PARAMS, m, isLOI);
  const arBatSorted = [...arRes.results].sort((a, b) => b.bei - a.bei);
  const arBowlSorted = [...arRes.results].filter(r => r.boei > 0).sort((a, b) => b.boei - a.boei);
  const arBatRankMap = {};
  arBatSorted.forEach((r, i) => { if (r.bei > 0) arBatRankMap[r.player.name] = i + 1; });
  const arBowlRankMap = {};
  arBowlSorted.forEach((r, i) => { arBowlRankMap[r.player.name] = i + 1; });

  const allrounders = [];
  for (const r of arRes.results) {
    if (r.bat_rating >= minArRating && r.bowl_rating >= minArRating) {
      const arEntry = {
        ...r.player,
        bat_rating: r.bat_rating,
        bowl_rating: r.bowl_rating,
        bat_rank: arBatRankMap[r.player.name] || null,
        bowl_rank: arBowlRankMap[r.player.name] || null,
        BEI: r.bei,
        BoEI: r.boei,
        ar_rating: Math.round(Math.sqrt(r.bat_rating * r.bowl_rating)),
      };
      allrounders.push(arEntry);
    }
  }
  allrounders.sort((a, b) => b.ar_rating - a.ar_rating);
  allrounders.forEach((pl, i) => { pl.ar_rank = i + 1; });
  DATA.allrounder_top25 = allrounders.slice(0, 100);

  DATA.metadata.bei_median = Math.round(beiMed * 100) / 100;
  DATA.metadata.bei_std = Math.round(beiStd * 100) / 100;
  DATA.metadata.boei_median = Math.round(boeiMed * 100) / 100;
  DATA.metadata.boei_std = Math.round(boeiStd * 100) / 100;

  DATA.metadata.ar_bei_median = Math.round(arRes.beiMed * 100) / 100;
  DATA.metadata.ar_bei_std = Math.round(arRes.beiStd * 100) / 100;
  DATA.metadata.ar_boei_median = Math.round(arRes.boeiMed * 100) / 100;
  DATA.metadata.ar_boei_std = Math.round(arRes.boeiStd * 100) / 100;
}

function isCustomParams() {
  if (Object.keys(TUNE_DEFAULTS).some(k => TUNE_PARAMS[k] !== TUNE_DEFAULTS[k])) return true;
  if (Object.keys(TUNE_DEFAULTS).some(k => AR_TUNE_PARAMS[k] !== TUNE_DEFAULTS[k])) return true;
  for (const [fmt, keys] of Object.entries(XF_PARAM_KEYS)) {
    for (const key of keys) {
      if (XF_TUNE_PARAMS[fmt][key] !== XF_TUNE_DEFAULTS[fmt][key]) return true;
    }
  }
  return false;
}

const BAT_PARAM_KEYS = ['batLongevity', 'batPitch', 'alpha', 'srWeight'];
const BOWL_PARAM_KEYS = ['bowlLongevity', 'bowlPitch', 'bowlSrWeight', 'bowlAvgW', 'wpiWeight'];

function resetParams() {
  TUNE_PARAMS = { ...TUNE_DEFAULTS };
  AR_TUNE_PARAMS = { ...TUNE_DEFAULTS };
  XF_TUNE_PARAMS = JSON.parse(JSON.stringify(XF_TUNE_DEFAULTS));
  resetToOriginalDataAll();
}

function resetParamsSection(keys) {
  const p = activeParams();
  for (const k of keys) {
    if (k in TUNE_DEFAULTS) p[k] = TUNE_DEFAULTS[k];
  }
  if (CURRENT_FORMAT === 'crossformat') {
    for (const [fmt, fmtKeys] of Object.entries(XF_PARAM_KEYS)) {
      for (const k of keys) {
        if (fmtKeys.includes(k)) XF_TUNE_PARAMS[fmt][k] = XF_TUNE_DEFAULTS[fmt][k];
      }
    }
  }
  resetToOriginalDataAll();
}

function resetToOriginalDataAll() {
  if (CURRENT_FORMAT === 'crossformat') {
    for (const fmt of ['tests', 'odis', 't20is']) {
      if (ALL_DATA[fmt] && ORIGINAL_DATA[fmt]) {
        ALL_DATA[fmt].all_players = JSON.parse(JSON.stringify(ORIGINAL_DATA[fmt].all_players));
        ALL_DATA[fmt].metadata = { ...ORIGINAL_DATA[fmt].metadata };
      }
    }
    return;
  }
  if (DATA && ORIGINAL_DATA[CURRENT_FORMAT]) {
    DATA.all_players = JSON.parse(JSON.stringify(ORIGINAL_DATA[CURRENT_FORMAT].all_players));
    DATA.batting_top25 = JSON.parse(JSON.stringify(ORIGINAL_DATA[CURRENT_FORMAT].batting_top25));
    DATA.bowling_top25 = JSON.parse(JSON.stringify(ORIGINAL_DATA[CURRENT_FORMAT].bowling_top25));
    DATA.allrounder_top25 = JSON.parse(JSON.stringify(ORIGINAL_DATA[CURRENT_FORMAT].allrounder_top25));
    DATA.metadata = { ...ORIGINAL_DATA[CURRENT_FORMAT].metadata };
  }
}

function storeOriginalData(format) {
  if (!ALL_DATA[format] || ORIGINAL_DATA[format]) return;
  ORIGINAL_DATA[format] = {
    all_players: JSON.parse(JSON.stringify(ALL_DATA[format].all_players)),
    batting_top25: JSON.parse(JSON.stringify(ALL_DATA[format].batting_top25)),
    bowling_top25: JSON.parse(JSON.stringify(ALL_DATA[format].bowling_top25)),
    allrounder_top25: JSON.parse(JSON.stringify(ALL_DATA[format].allrounder_top25)),
    metadata: { ...ALL_DATA[format].metadata },
  };
}

function isMobile() { return window.innerWidth <= 700; }

// Country code → flag emoji
const FLAGS = {
  AUS: '\u{1F1E6}\u{1F1FA}', ENG: '\u{1F1EC}\u{1F1E7}', IND: '\u{1F1EE}\u{1F1F3}',
  PAK: '\u{1F1F5}\u{1F1F0}', SA: '\u{1F1FF}\u{1F1E6}', WI: '\u{1F3DD}\uFE0F',
  NZ: '\u{1F1F3}\u{1F1FF}', SL: '\u{1F1F1}\u{1F1F0}', BAN: '\u{1F1E7}\u{1F1E9}',
  ZIM: '\u{1F1FF}\u{1F1FC}', AFG: '\u{1F1E6}\u{1F1EB}', IRE: '\u{1F1EE}\u{1F1EA}',
  ICC: '\u{1F3CF}',
};

function getFlag(country) {
  if (!country) return '';
  const skip = new Set(['ICC', 'Asia', 'Afr']);
  const parts = country.split('/');
  const real = parts.find(c => !skip.has(c)) || parts[0];
  return FLAGS[real] || '\u{1F3CF}';
}

const IPL_COLORS = {
  CSK: '#fdc913', MI: '#004ba0', RCB: '#d4213d', KKR: '#3a225d',
  DC: '#004c93', RR: '#ea1a85', PBKS: '#dd1f2d', SRH: '#ff822a',
  GT: '#1c1c2b', LSG: '#a72056', DCH: '#00a3e0', GL: '#e04f16', RPS: '#6f42c1',
};

function franchiseBadges(franchises) {
  if (!franchises || !franchises.length) return '';
  return franchises.map(f => {
    const bg = IPL_COLORS[f] || '#555';
    return `<span class="franchise-badge" style="background:${bg};color:#fff;padding:1px 5px;border-radius:3px;font-size:0.7em;margin-right:2px;font-weight:600">${f}</span>`;
  }).join('');
}

// Known full name → abbreviated name mappings for search
const FULL_NAMES = {};
function buildNameIndex() {
  if (!DATA) return;
  for (const p of DATA.all_players) {
    const parts = p.name.split(' ');
    if (parts.length >= 2) {
      const surname = parts[parts.length - 1].toLowerCase();
      if (!FULL_NAMES[surname]) FULL_NAMES[surname] = [];
      FULL_NAMES[surname].push(p.name);
    }
  }
}

function computeCrossFormat() {
  const tests = ALL_DATA.tests;
  const odis = ALL_DATA.odis;
  const t20is = ALL_DATA.t20is;
  if (!tests || !odis || !t20is) return null;

  const rawT = TUNE_PARAMS.xfTests, rawO = TUNE_PARAMS.xfOdis, rawI = TUNE_PARAMS.xfT20is;
  const wSum = rawT + rawO + rawI || 1;
  const wT = rawT / wSum, wO = rawO / wSum, wI = rawI / wSum;

  const playerMap = {};
  for (const [key, data] of [['tests', tests], ['odis', odis], ['t20is', t20is]]) {
    for (const p of data.all_players) {
      if (!playerMap[p.name]) playerMap[p.name] = {};
      playerMap[p.name][key] = p;
    }
  }

  const activeFmts = [];
  if (rawT > 0) activeFmts.push('tests');
  if (rawO > 0) activeFmts.push('odis');
  if (rawI > 0) activeFmts.push('t20is');

  const results = { batting: [], bowling: [], allrounders: [] };
  const weights = { tests: wT, odis: wO, t20is: wI };

  for (const [name, fmts] of Object.entries(playerMap)) {
    const hasFmts = activeFmts.filter(f => fmts[f]);
    if (hasFmts.length < activeFmts.length) continue;

    const wActive = hasFmts.reduce((s, f) => s + weights[f], 0) || 1;
    let bat = 0, bowl = 0;
    const entry = { name, country: (fmts.tests || fmts.odis || fmts.t20is).country };
    for (const f of hasFmts) {
      const w = weights[f] / wActive;
      bat += w * fmts[f].bat_rating;
      bowl += w * fmts[f].bowl_rating;
      entry[`bat_${f}`] = fmts[f].bat_rating;
      entry[`bowl_${f}`] = fmts[f].bowl_rating;
      entry[`matches_${f}`] = fmts[f].matches;
    }
    entry.bat_total = Math.round(bat);
    entry.bowl_total = Math.round(bowl);

    if (entry.bat_total > 0) results.batting.push(entry);
    if (entry.bowl_total > 0) results.bowling.push(entry);
    if (entry.bat_total >= XF_MIN_AR && entry.bowl_total >= XF_MIN_AR) {
      entry.ar_total = Math.round(Math.sqrt(entry.bat_total * entry.bowl_total));
      results.allrounders.push(entry);
    }
  }

  results.batting.sort((a, b) => b.bat_total - a.bat_total);
  results.bowling.sort((a, b) => b.bowl_total - a.bowl_total);
  results.allrounders.sort((a, b) => b.ar_total - a.ar_total);

  CROSS_FORMAT_DATA = { all3: results };
  return CROSS_FORMAT_DATA;
}

function searchPlayers(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const words = q.split(/\s+/);
  const surname = words[words.length - 1];
  const multiWord = words.length > 1;

  const scored = DATA.all_players.map(p => {
    const nameLower = p.name.toLowerCase();
    const nameParts = nameLower.split(' ');
    const playerSurname = nameParts[nameParts.length - 1];
    let score = 0;

    if (nameLower.includes(q)) score += 200;

    if (multiWord) {
      // Multi-word query: require surname match, then boost for other word matches
      if (playerSurname !== surname && !playerSurname.includes(surname)) return { player: p, score: 0 };
      score += 100;
      for (const w of words.slice(0, -1)) {
        if (nameLower.includes(w)) score += 40;
      }
    } else {
      // Single word: match anywhere in name, prioritize surname
      if (playerSurname === q) score += 150;
      else if (playerSurname.includes(q)) score += 80;
      else if (nameLower.includes(q)) score += 50;
    }

    return { player: p, score };
  }).filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score || b.player.AEI - a.player.AEI);
  return scored.slice(0, 12).map(s => s.player);
}

function plotlyLayout(overrides = {}) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: "'Inter', sans-serif", color: isDark ? '#e4e6ed' : '#1a1d27', size: 12 },
    margin: { l: 50, r: 30, t: 40, b: 40 },
    xaxis: { gridcolor: isDark ? '#2a2e3d' : '#dfe1e8', zerolinecolor: isDark ? '#2a2e3d' : '#dfe1e8' },
    yaxis: { gridcolor: isDark ? '#2a2e3d' : '#dfe1e8', zerolinecolor: isDark ? '#2a2e3d' : '#dfe1e8' },
    ...overrides,
  };
}

// ─── Data Loading ───────────────────────────────────────────────────────────

async function loadFormatData(format) {
  const file = FORMAT_FILES[format];
  if (!file) return null;
  if (ALL_DATA[format]) return ALL_DATA[format];
  try {
    const resp = await fetch(file);
    if (!resp.ok) return null;
    ALL_DATA[format] = await resp.json();
    return ALL_DATA[format];
  } catch (e) {
    return null;
  }
}

async function loadData() {
  try {
    ALL_DATA.tests = await loadFormatData('tests');
    DATA = ALL_DATA.tests;
    if (!DATA) throw new Error('No data');
    storeOriginalData('tests');
    buildNameIndex();

    const hash = location.hash.slice(1);
    const qsIdx = hash.indexOf('?');
    if (qsIdx !== -1) {
      decodeTuneParams(hash.slice(qsIdx + 1));
      if (isCustomParams()) {
        resetToOriginalData();
        recomputeRankings();
        updateTuneBadge();
      }
    }
    syncSlidersToParams();
    syncXfSliders();
    updateSrRowVisibility();

    renderAll();
    restoreFromHash();
    document.body.classList.add('loaded');
    loadFormatData('odis').then(() => storeOriginalData('odis'));
    loadFormatData('t20is').then(() => storeOriginalData('t20is'));
    loadFormatData('ipl').then(() => storeOriginalData('ipl'));
  } catch (e) {
    document.querySelector('.content').innerHTML =
      '<p style="text-align:center;padding:3rem;color:var(--accent3)">Failed to load rankings data. Make sure rankings.json is available.</p>';
  }
}

async function switchFormat(format) {
  if (format === CURRENT_FORMAT) return;

  if (format === 'crossformat') {
    const [tests, odis, t20is] = await Promise.all([
      loadFormatData('tests'), loadFormatData('odis'), loadFormatData('t20is')
    ]);
    if (!tests || !odis || !t20is) {
      alert('International format data not yet available.');
      return;
    }
    CURRENT_FORMAT = 'crossformat';
    DATA = null;
    computeCrossFormat();
  } else {
    const data = await loadFormatData(format);
    if (!data) {
      alert(`${FORMAT_LABELS[format]} rankings data not yet available.`);
      return;
    }
    CURRENT_FORMAT = format;
    DATA = data;
    storeOriginalData(format);
    buildNameIndex();
    updateFormatLabels();
    updateSrRowVisibility();
    if (isCustomParams()) {
      resetToOriginalData();
      recomputeRankings();
    }
    updateTuneBadge();
  }

  document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.format-btn[data-format="${format}"]`).classList.add('active');

  CURRENT_XI = new Array(11).fill(null);
  renderAll();

  const plTab = document.querySelector('.tab[data-tab="player-lookup"]');
  const xiTab = document.querySelector('.tab[data-tab="greatest-xi"]');
  const tunePanel = document.getElementById('tune-panel');
  const isXf = format === 'crossformat';
  if (xiTab) xiTab.style.display = isXf ? 'none' : '';
  if (isXf) {
    plTab.style.display = 'none';
    const curTab = document.querySelector('.tab.active')?.dataset.tab;
    if (curTab === 'player-lookup' || curTab === 'greatest-xi') {
      switchTab('allrounders', false);
    }
  } else {
    plTab.style.display = '';
    document.getElementById('player-card').classList.add('hidden');
    document.getElementById('player-search').value = '';
  }
  if (tunePanel) tunePanel.style.display = '';
  const regularSliders = document.getElementById('tune-regular-sliders');
  if (regularSliders) regularSliders.classList.toggle('hidden', isXf);
  document.querySelectorAll('.tune-xf-only').forEach(el => el.classList.toggle('hidden', !isXf));
  syncSlidersToParams();
  if (isXf) syncXfSliders();

  const activeTab = document.querySelector('.tab.active');
  const tabId = activeTab ? activeTab.dataset.tab : 'allrounders';
  switchTab(tabId, false);
  history.pushState(null, '', `#${format}/${tabId}`);
}

async function restoreFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return;
  const fullHash = decodeURIComponent(raw);

  const qsIdx = fullHash.indexOf('?');
  const hash = qsIdx >= 0 ? fullHash.slice(0, qsIdx) : fullHash;
  if (qsIdx >= 0) {
    decodeTuneParams(fullHash.slice(qsIdx + 1));
    syncSlidersToParams();
    syncXfSliders();
  }

  let format = CURRENT_FORMAT;
  let rest = hash;

  const formatPrefixes = [...Object.keys(FORMAT_FILES), 'crossformat'];
  for (const f of formatPrefixes) {
    if (hash === f || hash.startsWith(f + '/')) {
      format = f;
      rest = hash.slice(f.length + 1) || 'allrounders';
      break;
    }
  }

  if (format !== CURRENT_FORMAT) {
    if (format === 'crossformat') {
      const [tests, odis, t20is] = await Promise.all([
        loadFormatData('tests'), loadFormatData('odis'), loadFormatData('t20is')
      ]);
      if (tests && odis && t20is) {
        CURRENT_FORMAT = 'crossformat';
        DATA = null;
        computeCrossFormat();
        document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector('.format-btn[data-format="crossformat"]');
        if (btn) btn.classList.add('active');
        const plTab = document.querySelector('.tab[data-tab="player-lookup"]');
        if (plTab) plTab.style.display = 'none';
        const regularSliders = document.getElementById('tune-regular-sliders');
        if (regularSliders) regularSliders.classList.add('hidden');
        document.querySelectorAll('.tune-xf-only').forEach(el => el.classList.remove('hidden'));
        syncXfSliders();
        renderAll();
      }
    } else {
      const data = await loadFormatData(format);
      if (data) {
        CURRENT_FORMAT = format;
        DATA = data;
        storeOriginalData(format);
        document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.format-btn[data-format="${format}"]`);
        if (btn) btn.classList.add('active');
        const plTab = document.querySelector('.tab[data-tab="player-lookup"]');
        if (plTab) plTab.style.display = '';
        buildNameIndex();
        updateFormatLabels();
        updateSrRowVisibility();
        if (isCustomParams()) {
          resetToOriginalData();
          recomputeRankings();
        }
        updateTuneBadge();
        renderAll();
      }
    }
  }

  if (rest.startsWith('player/')) {
    if (CURRENT_FORMAT !== 'crossformat') {
      const name = rest.slice(7);
      switchTab('player-lookup', false);
      document.getElementById('player-search').value = name;
      setTimeout(() => showPlayer(name, false), 120);
    }
  } else {
    if (rest.startsWith('greatest-xi')) {
      switchTab('greatest-xi', false);
      const xiPart = rest.split('/').slice(1).join('/');
      if (xiPart) {
        decodeXiFromHash(xiPart);
      } else {
        CURRENT_XI = generateDefaultXI();
      }
      renderGreatestXI();
    } else {
      const validTabs = ['allrounders', 'batting', 'bowling', 'player-lookup', 'greatest-xi', 'methodology'];
      if (validTabs.includes(rest)) {
        if (rest === 'player-lookup' && CURRENT_FORMAT === 'crossformat') {
          switchTab('allrounders', false);
        } else {
          switchTab(rest, false);
        }
      }
    }
  }
}

function updateFormatLabels() {
  if (CURRENT_FORMAT === 'crossformat') return;
  const label = FORMAT_LABELS[CURRENT_FORMAT] || 'Test';
  document.getElementById('heading-allrounders').textContent = `Top 100 ${label} Allrounders`;
  document.getElementById('heading-batting').textContent = `Top 100 ${label} Batters`;
  document.getElementById('heading-bowling').textContent = `Top 100 ${label} Bowlers`;
  document.querySelector('#panel-batting .panel-desc').textContent = `The greatest batsmen in ${label} cricket history, ranked by career batting excellence. Click any player to explore their score breakdown.`;
  document.querySelector('#panel-bowling .panel-desc').textContent = `The greatest bowlers in ${label} cricket history, ranked by career bowling excellence. Click any player to explore their score breakdown.`;
}

function renderAll() {
  if (CURRENT_FORMAT === 'crossformat') {
    renderCrossFormatAll();
    return;
  }
  renderMeta();
  updateFormatLabels();
  renderAllrounderChart();
  renderAllrounderTable();
  renderBattingChart();
  renderBattingTable();
  renderBowlingChart();
  renderBowlingTable();
  renderMethodology();
  if (CURRENT_XI.every(p => !p)) {
    CURRENT_XI = generateDefaultXI();
  }
  renderGreatestXI();
}

function renderMeta() {
  const d = new Date(DATA.metadata.last_updated);
  document.getElementById('last-updated').textContent = `Last updated: ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  document.getElementById('player-count').textContent = `${DATA.metadata.total_players}`;
}

// ─── Allrounder Chart ───────────────────────────────────────────────────────

function renderAllrounderChart() {
  const mobile = isMobile();
  const n = mobile ? 15 : 25;
  const players = [...DATA.allrounder_top25].slice(0, n).reverse();
  const labels = players.map(p => mobile ? p.name.split(' ').pop() : `${getFlag(p.country)} ${p.name}`);

  const traces = [{
    y: labels, x: players.map(p => p.ar_rating), type: 'bar', orientation: 'h',
    marker: { color: players.map(p => p.ar_rating >= 1000 ? COLORS.aei : COLORS.bat) },
    text: players.map(p => p.ar_rating), textposition: 'inside',
    textfont: { color: '#fff', size: mobile ? 10 : 12, weight: 700 },
    hovertemplate: '%{y}<br>Rating: %{x}<br>Bat: %{customdata[0]} · Bowl: %{customdata[1]}<extra></extra>',
    customdata: players.map(p => [p.bat_rating, p.bowl_rating]),
  }];

  const layout = plotlyLayout({
    height: Math.max(mobile ? 400 : 550, players.length * (mobile ? 26 : 30) + 80),
    margin: { l: mobile ? 100 : 220, r: mobile ? 10 : 60, t: 10, b: 30 },
    xaxis: { title: 'Rating' },
    yaxis: { tickfont: { size: mobile ? 10 : 12 } },
    showlegend: false,
  });

  Plotly.newPlot('chart-allrounders', traces, layout, plotlyConfig);
}

// ─── Batting Chart ──────────────────────────────────────────────────────────

function renderBattingChart() {
  const mobile = isMobile();
  const n = mobile ? 15 : 25;
  const players = [...DATA.batting_top25].slice(0, n).reverse();
  const labels = players.map(p => mobile ? p.name.split(' ').pop() : `${getFlag(p.country)} ${p.name}`);

  const traces = [{
    y: labels, x: players.map(p => p.bat_rating), type: 'bar', orientation: 'h',
    marker: { color: players.map(p => p.bat_rating >= 1000 ? COLORS.aei : COLORS.bat) },
    text: players.map(p => p.bat_rating), textposition: 'inside',
    textfont: { color: '#fff', size: mobile ? 10 : 12, weight: 700 },
    hovertemplate: '%{y}<br>Rating: %{x}<br>%{customdata} matches<extra></extra>',
    customdata: players.map(p => p.matches),
  }];

  const layout = plotlyLayout({
    height: Math.max(mobile ? 400 : 550, players.length * (mobile ? 26 : 30) + 80),
    margin: { l: mobile ? 100 : 220, r: mobile ? 10 : 60, t: 10, b: 30 },
    xaxis: { title: 'Rating' },
    yaxis: { tickfont: { size: mobile ? 10 : 12 } },
    showlegend: false,
  });

  Plotly.newPlot('chart-batting', traces, layout, plotlyConfig);
}

// ─── Bowling Chart ──────────────────────────────────────────────────────────

function renderBowlingChart() {
  const mobile = isMobile();
  const n = mobile ? 15 : 25;
  const players = [...DATA.bowling_top25].slice(0, n).reverse();
  const labels = players.map(p => mobile ? p.name.split(' ').pop() : `${getFlag(p.country)} ${p.name}`);

  const traces = [{
    y: labels, x: players.map(p => p.bowl_rating), type: 'bar', orientation: 'h',
    marker: { color: players.map(p => p.bowl_rating >= 1000 ? COLORS.aei : COLORS.bowl) },
    text: players.map(p => p.bowl_rating), textposition: 'inside',
    textfont: { color: '#fff', size: mobile ? 10 : 12, weight: 700 },
    hovertemplate: '%{y}<br>Rating: %{x}<br>%{customdata} matches<extra></extra>',
    customdata: players.map(p => p.matches),
  }];

  const layout = plotlyLayout({
    height: Math.max(mobile ? 400 : 550, players.length * (mobile ? 26 : 30) + 80),
    margin: { l: mobile ? 100 : 220, r: mobile ? 10 : 60, t: 10, b: 30 },
    xaxis: { title: 'Rating' },
    yaxis: { tickfont: { size: mobile ? 10 : 12 } },
    showlegend: false,
  });

  Plotly.newPlot('chart-bowling', traces, layout, plotlyConfig);
}

// ─── Tables (ICC-style) ─────────────────────────────────────────────────────

function medalClass(i) {
  return i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
}

const ROLE_LABELS = {
  opener: 'Opener', middle: 'Middle Order', keeper: 'Keeper',
  allrounder: 'Allrounder', spinner: 'Spinner', fast: 'Fast Bowler',
};

function roleTag(p) {
  const r = p.playing_role;
  if (!r || !ROLE_LABELS[r]) return '';
  return `<span class="lb-role">${ROLE_LABELS[r]}</span>`;
}

function playerSubtitle(p) {
  const isIPL = CURRENT_FORMAT === 'ipl';
  const role = roleTag(p);
  if (isIPL && p.franchises && p.franchises.length) {
    return `${franchiseBadges(p.franchises)} · ${p.matches} matches${role ? ' · ' + role : ''}`;
  }
  return `${p.country} · ${p.matches} matches${role ? ' · ' + role : ''}`;
}

function renderAllrounderTable() {
  const container = document.getElementById('table-allrounders');
  container.innerHTML = DATA.allrounder_top25.map((p, i) => `
    <div class="lb-row ${medalClass(i)}" data-player="${p.name}">
      <div class="lb-rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="lb-flag">${getFlag(p.country)}</div>
      <div class="lb-info">
        <div class="lb-name">${p.name}</div>
        <div class="lb-country">${playerSubtitle(p)}</div>
      </div>
      <div class="lb-primary">
        <div class="lb-primary-val">${p.ar_rating}</div>
        <div class="lb-primary-label">Rating</div>
      </div>
      <button class="lb-xi-add" data-player="${p.name}" title="Add to XI">+</button>
    </div>
  `).join('');
  addRowClickHandlers(container);
}

function renderBattingTable() {
  const container = document.getElementById('table-batting');
  container.innerHTML = DATA.batting_top25.map((p, i) => `
    <div class="lb-row ${medalClass(i)}" data-player="${p.name}">
      <div class="lb-rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="lb-flag">${getFlag(p.country)}</div>
      <div class="lb-info">
        <div class="lb-name">${p.name}</div>
        <div class="lb-country">${playerSubtitle(p)}</div>
      </div>
      <div class="lb-primary">
        <div class="lb-primary-val">${p.bat_rating}</div>
        <div class="lb-primary-label">Rating</div>
      </div>
      <button class="lb-xi-add" data-player="${p.name}" title="Add to XI">+</button>
    </div>
  `).join('');
  addRowClickHandlers(container);
}

function renderBowlingTable() {
  const container = document.getElementById('table-bowling');
  container.innerHTML = DATA.bowling_top25.map((p, i) => `
    <div class="lb-row ${medalClass(i)}" data-player="${p.name}">
      <div class="lb-rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="lb-flag">${getFlag(p.country)}</div>
      <div class="lb-info">
        <div class="lb-name">${p.name}</div>
        <div class="lb-country">${playerSubtitle(p)}</div>
      </div>
      <div class="lb-primary">
        <div class="lb-primary-val">${p.bowl_rating}</div>
        <div class="lb-primary-label">Rating</div>
      </div>
      <button class="lb-xi-add" data-player="${p.name}" title="Add to XI">+</button>
    </div>
  `).join('');
  addRowClickHandlers(container);
}

function addRowClickHandlers(container) {
  container.querySelectorAll('.lb-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.lb-xi-add')) return;
      const name = row.dataset.player;
      const fromAR = activeTab() === 'allrounders';
      switchTab('player-lookup');
      document.getElementById('player-search').value = name;
      showPlayer(name, true, fromAR);
    });
  });
  container.querySelectorAll('.lb-xi-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      addToXI(btn.dataset.player);
      switchTab('greatest-xi');
    });
  });
}

// ─── KDE Distribution ───────────────────────────────────────────────────────

// ─── Methodology ────────────────────────────────────────────────────────────

function renderMethodology() {
  if (CURRENT_FORMAT === 'crossformat') { renderCrossFormatMethodology(); return; }
  const el = document.getElementById('methodology-content');
  if (!el) return;
  const m = DATA.metadata;
  const isLOI = CURRENT_FORMAT !== 'tests';
  const label = FORMAT_LABELS[CURRENT_FORMAT] || 'Test';

  const pitchDesc = isLOI
    ? `<p>For each player, we compute the <strong>overall batting average</strong> and <strong>runs per over</strong> across all ${label} matches they appeared in, and compare them to the all-time averages (avg: ${m.all_time_avg}, RPO: ${m.all_time_rpo}):</p>
      <div class="formula">
        Raw factor = (All-time avg / Match avg) × (All-time RPO / Match RPO)<br>
        Applied batting adjustment = factor<sup>${TUNE_PARAMS.batPitch.toFixed(2)}</sup> &nbsp; | &nbsp; Applied bowling adjustment = inverse_factor<sup>${TUNE_PARAMS.bowlPitch.toFixed(2)}</sup>
      </div>
      <p>The raw factor captures both era effects <strong>and</strong> the specific venues and conditions a player faced. We raise it to the <strong>pitch exponent</strong> (tunable, currently ${TUNE_PARAMS.batPitch.toFixed(2)} for batting, ${TUNE_PARAMS.bowlPitch.toFixed(2)} for bowling) to control the strength of the adjustment. At 0.5 (square root) the adjustment is softened significantly; at 1.0 it's applied in full. Bowling factors are computed inversely (higher match avg / RPO = easier for bowlers).</p>`
    : `<p>For each player, we compute the <strong>overall batting average</strong> (total runs ÷ total wickets) across all Test matches they appeared in, and compare it to the all-time average (${m.all_time_avg}):</p>
      <div class="formula">
        Raw factor = All-time avg / Match avg<br>
        Applied batting adjustment = factor<sup>${TUNE_PARAMS.batPitch.toFixed(2)}</sup> &nbsp; | &nbsp; Applied bowling adjustment = inverse_factor<sup>${TUNE_PARAMS.bowlPitch.toFixed(2)}</sup>
      </div>
      <p>The raw factor captures the specific grounds, pitch conditions, and opposition strength each player actually faced. We raise it to the <strong>pitch exponent</strong> (tunable, currently ${TUNE_PARAMS.batPitch.toFixed(2)} for batting, ${TUNE_PARAMS.bowlPitch.toFixed(2)} for bowling) to control the strength of the adjustment. At 0.5 (sqrt) the adjustment is softened — a player in tough conditions (e.g., match avg = 28, raw factor 1.14) receives a ~1.07× boost. At 1.0 the full factor is applied. Bowling factors are computed inversely (Match avg / All-time avg).</p>`;

  const arDesc = `<p>The AEI captures a player's combined contribution with bat and ball. However, allrounders are <strong>ranked by the geometric mean</strong> of their batting and bowling ratings — √(bat_rating × bowl_rating) — which naturally rewards <strong>balance</strong> between the two disciplines. A player who is elite in one but weak in the other will rank below someone who is very good in both. A player must achieve a minimum rating of <strong>${m.min_ar_rating}</strong> in both batting and bowling to qualify.</p>`;

  const arRankFormula = `AEI = BEI + BoEI<br>Ranking metric = √(bat_rating × bowl_rating)`;

  const batLongExp = TUNE_PARAMS.batLongevity;
  const bowlLongExp = TUNE_PARAMS.bowlLongevity;
  const alphaVal = TUNE_PARAMS.alpha;

  const ratingDesc = `
    <h3>Rating Scale</h3>
    <p>Pitch-adjusted indices are converted to ratings anchored at the <strong>median</strong> qualifying player = ${m.rating_base}. We compute how many standard deviations above (or below) the median a player sits, then apply square-root compression:</p>
    <div class="formula">
      Rating = ${m.rating_base} + ${m.rating_k} × √z &nbsp;&nbsp; where z = (value − median) / σ
    </div>
    <p>The square root compresses extreme outliers — going from 3σ to 4σ above the median adds far fewer points than going from 1σ to 2σ. Ratings above <strong>1000</strong> are all-time GOATs, <strong>900+</strong> is elite, <strong>800+</strong> is great, and <strong>700+</strong> is very good. Below the median, ratings scale linearly.</p>
  `;

  let html;
  if (isLOI) {
    html = `
    <h2>${label} Methodology</h2>

    <h3>The Problem with Career Averages</h3>
    <p>A career average tells you <em>how well</em> a player performed, but not <em>for how long</em>. A player who averages 45 at a strike rate of 130 over 30 ${label} matches is not the same as one who sustains those numbers over 150 ${label} matches. Our index rewards both quality and longevity.</p>

    <h3>Batting Excellence Index (BEI)</h3>
    <div class="formula">BEI = avg<sup>${(1-alphaVal).toFixed(1)}</sup> × RPI<sup>${alphaVal.toFixed(1)}</sup> × (SR / 100)<sup>${TUNE_PARAMS.srWeight.toFixed(1)}</sup> × innings<sup>${batLongExp.toFixed(2)}</sup></div>
    <p>The batting quality metric uses a <strong>weighted geometric mean</strong> of the career average and runs per innings (RPI = runs ÷ innings). Career average (runs ÷ dismissals) rewards not-outs, while RPI measures raw per-innings production. The weighting (avg<sup>${(1-alphaVal).toFixed(1)}</sup> × RPI<sup>${alphaVal.toFixed(1)}</sup>) applies a not-out correction — the higher the RPI exponent, the more players with inflated averages from not-outs are tempered. The result is multiplied by <strong>(SR/100)<sup>${TUNE_PARAMS.srWeight.toFixed(1)}</sup></strong> to capture scoring speed. The <strong>innings<sup>${batLongExp.toFixed(2)}</sup></strong> exponent provides a controlled longevity bonus. All these parameters are tunable.</p>

    <h3>Bowling Excellence Index (BoEI)</h3>
    <div class="formula">BoEI = (${m.bowl_k} / (SR<sup>${(2*TUNE_PARAMS.bowlSrWeight).toFixed(1)}</sup> × (econ/6)<sup>${(2*(1-TUNE_PARAMS.bowlSrWeight)).toFixed(1)}</sup>)) × balls<sup>${bowlLongExp.toFixed(2)}</sup> × scale</div>
    <p>In limited-overs cricket, a bowler's value comes from two quality factors — <strong>strike rate</strong> (balls per wicket) and <strong>economy rate</strong> (runs per over) — plus a longevity factor based on <strong>total balls bowled</strong>. Using balls bowled rather than innings ensures that part-time bowlers (who bowl a few overs per game) are naturally weighted less than full-time bowlers with the same SR and economy. The SR/economy balance is tunable. A data-driven scaling factor (×${m.boei_scale}) ensures that BEI and BoEI are on comparable scales. Bowlers must have at least <strong>20 bowling innings</strong> to qualify.</p>

    <h3>Pitch &amp; Era Normalization</h3>
    <p>Not all conditions are created equal. Averaging 50 on seaming pitches against quality attacks is a far greater achievement than averaging 50 on flat roads. We normalize for this by looking at the <strong>specific matches</strong> each player appeared in.</p>
    ${pitchDesc}
    <p>These pitch factors are applied to BEI and BoEI <strong>before</strong> the rating conversion, so the final ratings reflect how impressive a player's performance was <em>relative to the difficulty of the conditions they faced</em>. The pitch exponents for batting and bowling can be tuned independently.</p>

    <h3>Allrounder Excellence Index (AEI)</h3>
    <div class="formula">${arRankFormula}</div>
    ${arDesc}

    <h3>Minimum Qualification</h3>
    <p>Players must have played at least <strong>${m.min_matches} matches</strong> to qualify.${CURRENT_FORMAT === 'ipl' ? '' : ' Only ICC Full Member nations are included in the rankings.'}</p>

    <h3>Score Breakdown</h3>
    <p>Click on any player to see the factors going into their score — quality metrics, longevity, and pitch difficulty adjustments — showing exactly how their rating was computed.</p>

    ${ratingDesc}
    `;
  } else {
    html = `
    <h2>${label} Methodology</h2>

    <h3>The Problem with Career Averages</h3>
    <p>A player who averages 50 over 20 ${label} matches is <strong>not</strong> the same as someone who averages 50 over 180 ${label} matches. The second player sustained that level for nine times longer — through form slumps, injuries, pitch conditions across decades, and the wear of 160 extra matches. Career averages treat them identically. Our index does not.</p>

    <h3>Batting Excellence Index (BEI)</h3>
    <div class="formula">BEI = avg<sup>${(1-alphaVal).toFixed(1)}</sup> × RPI<sup>${alphaVal.toFixed(1)}</sup> × innings<sup>${batLongExp.toFixed(2)}</sup></div>
    <p>The batting quality metric uses a <strong>weighted geometric mean</strong> of the career average and runs per innings (RPI = runs ÷ innings). Career average (runs ÷ dismissals) rewards not-outs, while RPI measures raw per-innings production. The weighting (avg<sup>${(1-alphaVal).toFixed(1)}</sup> × RPI<sup>${alphaVal.toFixed(1)}</sup>) applies a not-out correction — the higher the RPI exponent, the more players with inflated averages from not-outs are tempered. The <strong>innings<sup>${batLongExp.toFixed(2)}</sup></strong> exponent provides a meaningful but controlled longevity bonus. All these parameters are tunable.</p>

    <h3>Bowling Excellence Index (BoEI)</h3>
    <div class="formula">BoEI = (${m.bowl_k} / avg<sup>${TUNE_PARAMS.bowlAvgW.toFixed(1)}</sup>) × (wpi / baseline)<sup>${TUNE_PARAMS.wpiWeight.toFixed(2)}</sup> × (baseline_sr / sr)<sup>${(m.sr_exp * 2 * TUNE_PARAMS.bowlSrWeight).toFixed(2)}</sup> × innings<sup>${bowlLongExp.toFixed(2)}</sup> × scale</div>
    <p>Bowling averages are "lower is better," so we flip them. The <strong>bowling average</strong> exponent (${TUNE_PARAMS.bowlAvgW.toFixed(1)}) controls how much average matters. The <strong>wickets per innings (wpi)</strong> factor captures volume — a strike bowler averaging 22 and taking 2.5 wickets per innings scores far higher than a part-timer averaging 22 but taking 1 per innings. The wpi exponent (${TUNE_PARAMS.wpiWeight.toFixed(2)}) controls how strongly this is rewarded.</p>
    <p>The <strong>strike rate factor</strong> gives a boost to bowlers who take wickets frequently. The baseline SR is ${m.baseline_sr} (mean across all qualifying bowlers). The SR exponent (${(m.sr_exp * 2 * TUNE_PARAMS.bowlSrWeight).toFixed(2)}) is tunable via the bowl SR weight slider.</p>
    <p>A data-driven scaling factor (×${m.boei_scale}) ensures that BEI and BoEI are on comparable scales. Bowlers must have at least <strong>${m.min_bowl_inns} bowling innings</strong> to qualify. All bowling parameters are tunable.</p>

    <h3>Pitch &amp; Era Normalization</h3>
    <p>Not all conditions are created equal. Averaging 50 on seaming pitches against quality attacks is a far greater achievement than averaging 50 on flat roads. We normalize for this by looking at the <strong>specific matches</strong> each player appeared in.</p>
    ${pitchDesc}
    <p>These pitch factors are applied to BEI and BoEI <strong>before</strong> the rating conversion, so the final ratings reflect how impressive a player's performance was <em>relative to the difficulty of the conditions they faced</em>. The pitch exponents for batting and bowling can be tuned independently.</p>

    <h3>Allrounder Excellence Index (AEI)</h3>
    <div class="formula">${arRankFormula}</div>
    ${arDesc}

    <h3>Minimum Qualification</h3>
    <p>Players must have played at least <strong>${m.min_matches || 20} matches</strong> to qualify. Only ICC Full Member nations are included in the rankings.</p>

    <h3>Score Breakdown</h3>
    <p>Click on any player to see the factors going into their score — quality metrics, longevity, and pitch difficulty adjustments — showing exactly how their rating was computed.</p>

    ${ratingDesc}
    `;
  }

  el.innerHTML = html;
}

// ─── Player Search ──────────────────────────────────────────────────────────

function setupSearch() {
  const input = document.getElementById('player-search');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q.length < 2) {
      results.classList.remove('open');
      return;
    }

    const matches = searchPlayers(q);

    if (matches.length === 0) {
      results.innerHTML = '<div class="search-result"><span class="sr-name">No results</span></div>';
    } else {
      results.innerHTML = matches.map(p => `
        <div class="search-result" data-name="${p.name}">
          <span class="sr-name">${getFlag(p.country)} ${p.name}</span>
          <span class="sr-meta">${playerSubtitle(p)}</span>
        </div>
      `).join('');
    }
    results.classList.add('open');

    results.querySelectorAll('.search-result[data-name]').forEach(el => {
      el.addEventListener('click', () => {
        input.value = el.dataset.name;
        results.classList.remove('open');
        showPlayer(el.dataset.name);
      });
    });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const matches = searchPlayers(input.value);
      if (matches.length > 0) {
        input.value = matches[0].name;
        results.classList.remove('open');
        showPlayer(matches[0].name);
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      results.classList.remove('open');
    }
  });
}

function _percentile(arr, val) {
  const below = arr.filter(v => v < val).length;
  return Math.round(below / arr.length * 100);
}

function _tier(pct) {
  if (pct >= 99) return ['GOAT', 'bd-tier-goat'];
  if (pct >= 95) return ['Elite', 'bd-tier-elite'];
  if (pct >= 85) return ['Excellent', 'bd-tier-excellent'];
  if (pct >= 80) return ['Great', 'bd-tier-great'];
  if (pct >= 60) return ['Good', 'bd-tier-good'];
  if (pct >= 40) return ['Average', 'bd-tier-avg'];
  return ['Below avg', 'bd-tier-below'];
}

function _barHTML(label, displayVal, pct, tierLabel, tierClass) {
  return `<div class="bd-row">
    <div class="bd-row-label">${label}</div>
    <div class="bd-row-body">
      <div class="bd-bar-track"><div class="bd-bar-fill ${tierClass}" style="width:${Math.min(pct, 100)}%"></div></div>
      <div class="bd-row-vals">
        <span class="bd-row-stat">${displayVal}</span>
        <span class="bd-row-tier ${tierClass}">${tierLabel}</span>
        <span class="bd-row-pct">top ${100 - pct}%</span>
      </div>
    </div>
  </div>`;
}

function renderScoreBreakdown(player) {
  const m = DATA.metadata;
  const isLOI = CURRENT_FORMAT !== 'tests';
  const isAR = _showPlayerFromAR;
  const p = isAR ? AR_TUNE_PARAMS : TUNE_PARAMS;
  const α = p.alpha;
  const batLongevity = p.batLongevity;
  const bowlLongevity = p.bowlLongevity;
  const rBase = m.rating_base || 500;
  const rK = p.ratingK;
  const batPitchExp = p.batPitch;
  const bowlPitchExp = p.bowlPitch;
  const all = DATA.all_players;

  const sections = [];

  // ── Batting breakdown ──
  if (player.bat_rating > 0 && player.career_bat_avg != null && player.bat_inns > 0) {
    const avg = player.career_bat_avg;
    const rpi = player.career_rpi || avg;
    const inns = player.bat_inns;
    const sr = player.career_bat_sr;
    const pitchAdj = player.bat_pitch_factor || 1;

    const qualityMetric = Math.pow(avg, 1 - α) * Math.pow(rpi, α);
    const longevityFactor = Math.pow(inns, batLongevity);

    const batters = all.filter(p => p.bat_inns > 0 && p.career_bat_avg > 0);
    const allAvg = batters.map(p => p.career_bat_avg);
    const allRpi = batters.map(p => p.career_rpi || p.career_bat_avg);
    const allInns = batters.map(p => p.bat_inns);
    const allQuality = batters.map(p => Math.pow(p.career_bat_avg, 1-α) * Math.pow(p.career_rpi || p.career_bat_avg, α));

    const avgPct = _percentile(allAvg, avg);
    const [avgTier, avgTierClass] = _tier(avgPct);
    const rpiPct = _percentile(allRpi, rpi);
    const [rpiTier, rpiTierClass] = _tier(rpiPct);
    const innsPct = _percentile(allInns, inns);
    const [innsTier, innsTierClass] = _tier(innsPct);

    let bars = '';
    bars += _barHTML('Average', `${avg.toFixed(1)}`, avgPct, avgTier, avgTierClass);
    bars += _barHTML('Runs/Innings', `${rpi.toFixed(1)}`, rpiPct, rpiTier, rpiTierClass);

    if (isLOI && sr) {
      const allSr = batters.filter(p => p.career_bat_sr > 0).map(p => p.career_bat_sr);
      const srPct = _percentile(allSr, sr);
      const [srTier, srTierClass] = _tier(srPct);
      bars += _barHTML('Strike Rate', `SR ${sr.toFixed(1)}`, srPct, srTier, srTierClass);
    }

    bars += _barHTML('Longevity', `${inns} innings`, innsPct, innsTier, innsTierClass);

    if (player.match_avg) {
      const allMatchAvg = all.filter(p => p.match_avg > 0).map(p => p.match_avg);
      const condPct = _percentile(allMatchAvg.map(v => -v), -player.match_avg);
      let condLabel, condClass;
      if (condPct >= 60)      { condLabel = 'Tough'; condClass = 'bd-tier-elite'; }
      else if (condPct >= 35) { condLabel = 'Medium'; condClass = 'bd-tier-good'; }
      else                    { condLabel = 'Easy'; condClass = 'bd-tier-avg'; }
      const econSuffix = isLOI && player.match_rpo ? ` · Pitch econ ${player.match_rpo.toFixed(2)}` : '';
      bars += _barHTML('Conditions', `Pitch avg ${player.match_avg.toFixed(1)}${econSuffix}`, condPct, condLabel, condClass);
    }

    const beiMedian = isAR ? m.ar_bei_median : m.bei_median;
    const beiStd = isAR ? m.ar_bei_std : m.bei_std;
    const z = beiStd > 0 ? (player.BEI - beiMedian) / beiStd : 0;
    const sdLabel = z >= 0 ? `${z.toFixed(1)} standard deviations above` : `${Math.abs(z).toFixed(1)} standard deviations below`;

    const formulaParts = [];
    formulaParts.push(`avg<sup>${(1-α).toFixed(1)}</sup> × rpi<sup>${α.toFixed(1)}</sup> = ${avg}^${(1-α).toFixed(1)} × ${rpi.toFixed(1)}^${α.toFixed(1)} = ${qualityMetric.toFixed(2)}`);
    if (isLOI && sr) {
      const srW = p.srWeight;
      formulaParts.push(`× (SR/100)<sup>${srW.toFixed(1)}</sup> = × ${Math.pow(sr/100, srW).toFixed(2)}`);
    }
    formulaParts.push(`× innings<sup>${batLongevity.toFixed(2)}</sup> = × ${inns}^${batLongevity.toFixed(2)} = × ${longevityFactor.toFixed(2)}`);
    if (pitchAdj !== 1 && batPitchExp > 0) {
      const adjVal = Math.pow(pitchAdj, batPitchExp);
      formulaParts.push(`× pitch<sup>${batPitchExp.toFixed(1)}</sup> = × ${pitchAdj.toFixed(4)}^${batPitchExp.toFixed(1)} = × ${adjVal.toFixed(4)}`);
    }
    formulaParts.push(`= Raw BEI: <strong>${player.BEI.toFixed(1)}</strong>`);
    const zFormula = z >= 0
      ? `Rating = ${rBase} + ${rK} × √${z.toFixed(2)} = <strong>${player.bat_rating}</strong>`
      : `Rating = ${rBase} + ${rK} × (${z.toFixed(2)}) = <strong>${player.bat_rating}</strong>`;

    sections.push(`
      <div class="bd-section">
        <div class="bd-title bei">Batting: ${player.bat_rating}${player.bat_rank ? ` (#${player.bat_rank})` : ''}</div>
        ${bars}
        <div class="bd-summary">${sdLabel} the median player</div>
        <details class="bd-formula-toggle"><summary>Show formula</summary><div class="bd-formula-body">${formulaParts.join('<br>')}<br>z = (${player.BEI.toFixed(1)} − ${beiMedian.toFixed(1)}) / ${beiStd.toFixed(1)} = ${z.toFixed(2)}<br>${zFormula}</div></details>
      </div>
    `);
  }

  // ── Bowling breakdown ──
  if (player.bowl_rating > 0 && player.career_bowl_avg != null && player.bowl_inns > 0) {
    const bowlAvg = player.career_bowl_avg;
    const bowlInns = player.bowl_inns;
    const ballsBowled = player.balls_bowled || 0;
    const pitchAdj = player.bowl_pitch_factor || 1;
    const bowlK = p.bowlK;
    const longevityBase = isLOI && ballsBowled > 0 ? ballsBowled : bowlInns;
    const longevityFactor = Math.pow(longevityBase, bowlLongevity);

    const bowlers = all.filter(p => p.bowl_inns > 0 && p.career_bowl_avg > 0);
    const allBowlAvg = bowlers.map(p => p.career_bowl_avg);
    const allLongevity = isLOI ? bowlers.map(p => p.balls_bowled || p.bowl_inns) : bowlers.map(p => p.bowl_inns);

    const bowlAvgPct = _percentile(allBowlAvg.map(v => -v), -bowlAvg);
    const [bowlAvgTier, bowlAvgTierClass] = _tier(bowlAvgPct);
    const longPct = _percentile(allLongevity, longevityBase);
    const [longTier, longTierClass] = _tier(longPct);

    let bars = '';

    if (isLOI) {
      const bowlSr = player.career_bowl_sr;
      const econ = player.career_bowl_econ || 6;
      if (bowlSr) {
        const allBowlSr = bowlers.filter(p => p.career_bowl_sr > 0).map(p => p.career_bowl_sr);
        const srPct = _percentile(allBowlSr.map(v => -v), -bowlSr);
        const [srTier, srTierClass] = _tier(srPct);
        bars += _barHTML('Strike Rate', `SR ${bowlSr.toFixed(1)}`, srPct, srTier, srTierClass);
      }
      const allEcon = bowlers.filter(p => p.career_bowl_econ > 0).map(p => p.career_bowl_econ);
      const econPct = _percentile(allEcon.map(v => -v), -econ);
      const [econTier, econTierClass] = _tier(econPct);
      bars += _barHTML('Economy', `${econ.toFixed(2)}`, econPct, econTier, econTierClass);
    } else {
      bars += _barHTML('Average', `Avg ${bowlAvg.toFixed(1)}`, bowlAvgPct, bowlAvgTier, bowlAvgTierClass);
      if (player.career_wpi != null) {
        const allWpi = bowlers.filter(p => p.career_wpi > 0).map(p => p.career_wpi);
        const wpiPct = _percentile(allWpi, player.career_wpi);
        const [wpiTier, wpiTierClass] = _tier(wpiPct);
        bars += _barHTML('Wkts/Innings', `${player.career_wpi.toFixed(2)} wkts/inn`, wpiPct, wpiTier, wpiTierClass);
      }
      if (player.career_bowl_sr) {
        const allBowlSr = bowlers.filter(p => p.career_bowl_sr > 0).map(p => p.career_bowl_sr);
        const srPct = _percentile(allBowlSr.map(v => -v), -player.career_bowl_sr);
        const [srTier, srTierClass] = _tier(srPct);
        bars += _barHTML('Strike rate', `SR ${player.career_bowl_sr.toFixed(1)}`, srPct, srTier, srTierClass);
      }
    }

    const longLabel = isLOI && ballsBowled > 0 ? `${ballsBowled} balls` : `${bowlInns} innings`;
    bars += _barHTML('Longevity', longLabel, longPct, longTier, longTierClass);

    if (player.match_avg) {
      const allMatchAvg = all.filter(p => p.match_avg > 0).map(p => p.match_avg);
      const condPct = _percentile(allMatchAvg, player.match_avg);
      let condLabel, condClass;
      if (condPct >= 60)      { condLabel = 'Tough'; condClass = 'bd-tier-elite'; }
      else if (condPct >= 35) { condLabel = 'Medium'; condClass = 'bd-tier-good'; }
      else                    { condLabel = 'Easy'; condClass = 'bd-tier-avg'; }
      let condValue;
      if (isLOI && player.match_rpo) {
        condValue = `Pitch avg ${player.match_avg.toFixed(1)} · Pitch econ ${player.match_rpo.toFixed(2)}`;
      } else {
        condValue = `Pitch avg ${player.match_avg.toFixed(1)}`;
      }
      bars += _barHTML('Conditions', condValue, condPct, condLabel, condClass);
    }

    const boeiMedian = isAR ? m.ar_boei_median : m.boei_median;
    const boeiStd = isAR ? m.ar_boei_std : m.boei_std;
    const z = boeiStd > 0 ? (player.BoEI - boeiMedian) / boeiStd : 0;
    const sdLabel = z >= 0 ? `${z.toFixed(1)} standard deviations above` : `${Math.abs(z).toFixed(1)} standard deviations below`;

    let formulaParts = [];
    if (isLOI) {
      const bowlSr = player.career_bowl_sr || (bowlAvg * 6 / (player.career_bowl_econ || 6));
      const econ = player.career_bowl_econ || 6;
      formulaParts.push(`${bowlK} / (SR × econ/6) = ${bowlK} / (${bowlSr.toFixed(1)} × ${(econ/6).toFixed(2)}) = ${(bowlK / (bowlSr * econ / 6)).toFixed(2)}`);
    } else {
      const baw = p.bowlAvgW;
      const avgTerm = bowlK / Math.pow(bowlAvg, baw);
      formulaParts.push(`${bowlK} / avg<sup>${baw.toFixed(1)}</sup> = ${bowlK} / ${bowlAvg.toFixed(1)}^${baw.toFixed(1)} = ${avgTerm.toFixed(2)}`);
      if (player.career_wpi != null) {
        const baseWpi = m.baseline_wpi || 1.46;
        const wpiW = p.wpiWeight;
        const wpiVal = Math.pow(player.career_wpi / baseWpi, wpiW);
        formulaParts.push(`× (wpi/baseline)<sup>${wpiW.toFixed(2)}</sup> = (${player.career_wpi.toFixed(3)}/${baseWpi})^${wpiW.toFixed(2)} = ${wpiVal.toFixed(2)}`);
      }
      if (player.career_bowl_sr) {
        const baseSr = m.baseline_sr || 79.9;
        const srExp = m.sr_exp || 0.2;
        formulaParts.push(`× (${baseSr}/sr)^${srExp} = (${baseSr}/${player.career_bowl_sr})^${srExp} = ${Math.pow(baseSr/player.career_bowl_sr, srExp).toFixed(2)}`);
      }
    }
    const longTermLabel = isLOI && ballsBowled > 0 ? 'balls' : 'innings';
    formulaParts.push(`× ${longTermLabel}<sup>${bowlLongevity.toFixed(2)}</sup> = × ${longevityBase}^${bowlLongevity.toFixed(2)} = × ${longevityFactor.toFixed(2)}`);
    if (pitchAdj !== 1 && bowlPitchExp > 0) {
      const adjVal = Math.pow(pitchAdj, bowlPitchExp);
      formulaParts.push(`× pitch<sup>${bowlPitchExp.toFixed(1)}</sup> = × ${pitchAdj.toFixed(4)}^${bowlPitchExp.toFixed(1)} = × ${adjVal.toFixed(4)}`);
    }
    formulaParts.push(`= Raw BoEI: <strong>${player.BoEI.toFixed(1)}</strong>`);
    const zFormula = z >= 0
      ? `Rating = ${rBase} + ${rK} × √${z.toFixed(2)} = <strong>${player.bowl_rating}</strong>`
      : `Rating = ${rBase} + ${rK} × (${z.toFixed(2)}) = <strong>${player.bowl_rating}</strong>`;

    sections.push(`
      <div class="bd-section">
        <div class="bd-title boei">Bowling: ${player.bowl_rating}${player.bowl_rank ? ` (#${player.bowl_rank})` : ''}</div>
        ${bars}
        <div class="bd-summary">${sdLabel} the median player</div>
        <details class="bd-formula-toggle"><summary>Show formula</summary><div class="bd-formula-body">${formulaParts.join('<br>')}<br>z = (${player.BoEI.toFixed(1)} − ${boeiMedian.toFixed(1)}) / ${boeiStd.toFixed(1)} = ${z.toFixed(2)}<br>${zFormula}</div></details>
      </div>
    `);
  }

  if (sections.length === 0) {
    document.getElementById('score-breakdown').innerHTML = '';
    return;
  }

  const bowlFirst = player.bowl_rating > player.bat_rating;
  if (bowlFirst) sections.reverse();

  document.getElementById('score-breakdown').innerHTML = `
    <details class="bd-card" open>
      <summary class="bd-header">Score Breakdown</summary>
      ${sections.join('')}
      <div class="bd-footnote">GOAT = top 1% · Elite = top 5% · Excellent = top 15% · Great = top 20% · Good = top 40% · Average = top 60%</div>
    </details>
  `;
}

let _showPlayerFromAR = false;
function showPlayer(name, updateHash = true, fromAllrounders = false) {
  const isAR = fromAllrounders || activeTab() === 'allrounders';
  _showPlayerFromAR = isAR;
  const source = isAR ? DATA.allrounder_top25 : DATA.all_players;
  const player = source.find(p => p.name === name) || DATA.all_players.find(p => p.name === name);
  if (!player) return;

  if (updateHash) {
    history.pushState(null, '', `#${CURRENT_FORMAT}/player/${encodeURIComponent(name)}`);
  }

  const card = document.getElementById('player-card');
  card.classList.remove('hidden');

  const bowlFirst = player.bowl_rating > player.bat_rating;

  let stats = '';
  const batStat = player.bat_rating > 0
    ? `<div class="ph-stat"><div class="label">Bat Rating</div><div class="value bei">${player.bat_rating}${player.bat_rank ? ` (#${player.bat_rank})` : ''}</div></div>` : '';
  const bowlStat = player.bowl_rating > 0
    ? `<div class="ph-stat"><div class="label">Bowl Rating</div><div class="value boei">${player.bowl_rating}${player.bowl_rank ? ` (#${player.bowl_rank})` : ''}</div></div>` : '';
  stats = bowlFirst ? bowlStat + batStat : batStat + bowlStat;
  if (player.ar_rank) {
    stats += `<div class="ph-stat"><div class="label">Allrounder</div><div class="value">${player.ar_rating} (#${player.ar_rank})</div></div>`;
  }

  let careerStats = '';
  const isLOI = CURRENT_FORMAT !== 'tests';
  const parts = [];
  const batParts = [];
  const bowlParts = [];
  if (player.career_bat_avg != null) batParts.push(`Bat Avg ${player.career_bat_avg.toFixed(2)}`);
  if (isLOI && player.career_bat_sr != null) batParts.push(`Bat SR ${player.career_bat_sr.toFixed(1)}`);
  if (isLOI && player.career_bowl_sr != null) bowlParts.push(`Bowl SR ${player.career_bowl_sr.toFixed(1)}`);
  if (!isLOI && player.career_bowl_avg != null) bowlParts.push(`Bowl Avg ${player.career_bowl_avg.toFixed(2)}`);
  if (isLOI && player.career_bowl_econ != null) bowlParts.push(`Bowl Econ ${player.career_bowl_econ.toFixed(2)}`);
  if (bowlFirst) { parts.push(...bowlParts, ...batParts); } else { parts.push(...batParts, ...bowlParts); }
  if (parts.length > 0) {
    careerStats = `<div class="ph-career">${parts.join(' · ')}</div>`;
  }

  let pitchInfo = '';
  if (player.match_avg && player.bat_pitch_factor) {
    const matchAvg = player.match_avg.toFixed(1);
    const sp = isAR ? AR_TUNE_PARAMS : TUNE_PARAMS;
    const batF = Math.pow(player.bat_pitch_factor, sp.batPitch).toFixed(2);
    const bowlF = Math.pow(player.bowl_pitch_factor, sp.bowlPitch).toFixed(2);
    const rpoLabel = player.match_rpo ? ` · Match RPO: ${player.match_rpo.toFixed(2)}` : '';
    pitchInfo = `<div class="ph-era">Match avg: ${matchAvg}${rpoLabel} · Bat adj: ${batF}× · Bowl adj: ${bowlF}×</div>`;
  }

  document.getElementById('player-header').innerHTML = `
    <div>
      <div class="ph-name">${getFlag(player.country)} ${player.name}</div>
      <div class="ph-country">${playerSubtitle(player)}</div>
      ${careerStats}
      ${pitchInfo}
    </div>
    <div class="ph-stats">${stats}</div>
  `;

  renderScoreBreakdown(player);
}

function renderPlayerCareer(player) {
  const isLOI = CURRENT_FORMAT !== 'tests';

  let batLabels, batVals, bowlLabels, bowlVals, batSRVals, econVals;

  if (isLOI && player.bat_stints) {
    batLabels = player.bat_stints.map(s => s.label);
    batVals = player.bat_stints.map(s => s.bat_avg);
    batSRVals = player.bat_stints.map(s => s.bat_sr);
    bowlLabels = (player.bowl_stints || []).map(s => s.label);
    bowlVals = (player.bowl_stints || []).map(s => s.bowl_avg);
    econVals = (player.bowl_stints || []).map(s => s.econ);
  } else {
    const stints = player.stints || [];
    batLabels = stints.map(s => s.label);
    batVals = stints.map(s => s.bat_avg);
    bowlLabels = stints.map(s => s.label);
    bowlVals = stints.map(s => s.bowl_avg);
    batSRVals = null;
    econVals = null;
  }

  const hasBat = batVals.some(v => v != null);
  const hasBowl = bowlVals.some(v => v != null);

  const rows = [];
  const bowlFirstChart = player.bowl_rating > player.bat_rating;
  if (bowlFirstChart) {
    if (hasBowl) rows.push('bowl');
    if (hasBat) rows.push('bat');
  } else {
    if (hasBat) rows.push('bat');
    if (hasBowl) rows.push('bowl');
  }

  if (rows.length === 0) {
    document.getElementById('chart-player-career').innerHTML =
      '<p style="padding:2rem;text-align:center;color:var(--text-muted)">No qualifying stint data for this player.</p>';
    return;
  }

  const traces = [];
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gc = isDark ? '#2a2e3d' : '#dfe1e8';
  const textColor = isDark ? '#e4e6ed' : '#1a1d27';
  const srColor = '#AB63FA';

  let axisIdx = 0;
  const axisMap = {};
  for (const r of rows) {
    axisIdx++;
    axisMap[r] = axisIdx;
  }

  function xKey(r) { return axisMap[r] === 1 ? 'x' : `x${axisMap[r]}`; }
  function yKey(r) { return axisMap[r] === 1 ? 'y' : `y${axisMap[r]}`; }

  if (hasBat) {
    const hoverFn = isLOI
      ? (v, i) => v != null ? `Matches ${batLabels[i]}<br>Avg: ${v.toFixed(1)}${batSRVals[i] != null ? `<br>SR: ${batSRVals[i].toFixed(1)}` : ''}` : ''
      : (v, i) => v != null ? `Matches ${batLabels[i]}<br>Batting Avg: ${v.toFixed(1)}` : '';

    traces.push({
      x: batLabels, y: batVals, type: 'bar', name: 'Batting Avg',
      marker: { color: batVals.map(v => v != null ? COLORS.bat : '#555') },
      opacity: 0.4, text: batVals.map(v => v != null ? v.toFixed(1) : ''),
      textposition: 'outside', cliponaxis: false, showlegend: false,
      hovertext: batVals.map((v, i) => hoverFn(v, i)),
      hoverinfo: 'text',
      xaxis: xKey('bat'), yaxis: yKey('bat'),
    });
    const valid = batVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
    if (valid.length >= 2) {
      traces.push({
        x: valid.map(([i]) => batLabels[i]), y: valid.map(([, v]) => v),
        type: 'scatter', mode: 'lines',
        line: { color: COLORS.bat, width: 3, shape: 'spline' }, showlegend: false,
        hoverinfo: 'skip',
        xaxis: xKey('bat'), yaxis: yKey('bat'),
      });
    }

    if (isLOI && batSRVals && batSRVals.some(v => v != null)) {
      const srValid = batSRVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
      if (srValid.length >= 2) {
        const yAxisSR = `y${axisMap['bat'] * 10}`;
        traces.push({
          x: srValid.map(([i]) => batLabels[i]), y: srValid.map(([, v]) => v),
          type: 'scatter', mode: 'lines+markers',
          line: { color: srColor, width: 2, dash: 'dot' },
          marker: { size: 5, color: srColor },
          name: 'Strike Rate', showlegend: true,
          hoverinfo: 'skip',
          xaxis: xKey('bat'), yaxis: yAxisSR,
        });
      }
    }
  }

  if (hasBowl) {
    const hoverFn = isLOI
      ? (v, i) => v != null ? `Matches ${bowlLabels[i]}<br>Avg: ${v.toFixed(1)}${econVals[i] != null ? `<br>Econ: ${econVals[i].toFixed(2)}` : ''}` : ''
      : (v, i) => v != null ? `Matches ${bowlLabels[i]}<br>Bowling Avg: ${v.toFixed(1)}` : '';

    traces.push({
      x: bowlLabels, y: bowlVals, type: 'bar', name: 'Bowling Avg',
      marker: { color: bowlVals.map(v => v != null ? COLORS.bowl : '#555') },
      opacity: 0.4, text: bowlVals.map(v => v != null ? v.toFixed(1) : ''),
      textposition: 'outside', cliponaxis: false, showlegend: false,
      hovertext: bowlVals.map((v, i) => hoverFn(v, i)),
      hoverinfo: 'text',
      xaxis: xKey('bowl'), yaxis: yKey('bowl'),
    });
    const valid = bowlVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
    if (valid.length >= 2) {
      traces.push({
        x: valid.map(([i]) => bowlLabels[i]), y: valid.map(([, v]) => v),
        type: 'scatter', mode: 'lines',
        line: { color: COLORS.bowl, width: 3, shape: 'spline' }, showlegend: false,
        hoverinfo: 'skip',
        xaxis: xKey('bowl'), yaxis: yKey('bowl'),
      });
    }

    if (isLOI && econVals && econVals.some(v => v != null)) {
      const econValid = econVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
      if (econValid.length >= 2) {
        const yAxisEcon = `y${axisMap['bowl'] * 10}`;
        traces.push({
          x: econValid.map(([i]) => bowlLabels[i]), y: econValid.map(([, v]) => v),
          type: 'scatter', mode: 'lines+markers',
          line: { color: '#FF6692', width: 2, dash: 'dot' },
          marker: { size: 5, color: '#FF6692' },
          name: 'Economy', showlegend: true,
          hoverinfo: 'skip',
          xaxis: xKey('bowl'), yaxis: yAxisEcon,
        });
      }
    }
  }

  const totalRows = rows.length;
  const gap = 0.18;

  const domains = [];
  let cursor = totalRows === 1 ? 0.88 : 1;
  for (let ri = 0; ri < totalRows; ri++) {
    const frac = totalRows === 2 ? 0.38 : 0.85;
    const top = cursor;
    const bottom = cursor - frac;
    domains.push([Math.max(0, bottom), top]);
    cursor = bottom - gap;
  }

  const batMax = hasBat ? Math.max(...batVals.filter(v => v != null), 10) : 10;
  const bowlMax = hasBowl ? Math.max(...bowlVals.filter(v => v != null), 10) : 10;

  const mobile = isMobile();

  const layout = {
    ...plotlyLayout(),
    height: totalRows === 1 ? (mobile ? 350 : 420) : (mobile ? 600 : 750),
    showlegend: isLOI,
    legend: isLOI ? { orientation: 'h', y: 1.12, x: 0.5, xanchor: 'center', font: { size: 11 } } : undefined,
    margin: { l: mobile ? 40 : 60, r: isLOI ? (mobile ? 50 : 70) : (mobile ? 15 : 30), t: isLOI ? (mobile ? 40 : 50) : (mobile ? 10 : 10), b: mobile ? 30 : 40 },
    annotations: [],
  };

  const stintInns = DATA.metadata.stint_innings || 20;
  const stintSize = DATA.metadata.stint_size || 10;

  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const n = ri + 1;
    const xName = n === 1 ? 'xaxis' : `xaxis${n}`;
    const yName = n === 1 ? 'yaxis' : `yaxis${n}`;

    const xDomain = isLOI ? [0, 0.92] : [0, 1];
    layout[xName] = { gridcolor: gc, domain: xDomain, anchor: n === 1 ? 'y' : `y${n}`, tickfont: { size: mobile ? 9 : 12 } };
    layout[yName] = { gridcolor: gc, domain: domains[ri], anchor: n === 1 ? 'x' : `x${n}` };

    const mutedColor = isDark ? '#8b8fa3' : '#6b7085';
    const annoY = domains[ri][1] + (totalRows === 1 ? 0.06 : 0.05);

    if (r === 'bat') {
      layout[yName].title = { text: 'Batting Average', font: { size: 11 }, standoff: 5 };
      layout[yName].range = [0, batMax * 1.3];
      const windowDesc = isLOI ? `${stintInns}-innings window` : `${stintSize}-match window`;
      const minDesc = isLOI ? `${stintInns} innings` : `10 batting innings`;
      const sub = mobile ? `Per ${windowDesc} (min. ${minDesc})` : `Average for each ${windowDesc} (min. ${minDesc} to qualify)`;
      layout.annotations.push({
        text: `<b>Batting Average per Stint</b><br><span style="color:${mutedColor};font-size:${mobile ? 9 : 11}px">${sub}</span>`,
        xref: 'paper', yref: 'paper', x: 0.5, y: annoY, showarrow: false,
        font: { size: mobile ? 12 : 14, color: textColor },
      });

      if (isLOI && batSRVals && batSRVals.some(v => v != null)) {
        const srAxisName = `yaxis${axisMap['bat'] * 10}`;
        const srMax = Math.max(...batSRVals.filter(v => v != null), 50);
        layout[srAxisName] = {
          gridcolor: 'rgba(0,0,0,0)', domain: domains[ri],
          anchor: 'free', overlaying: n === 1 ? 'y' : `y${n}`,
          side: 'right', position: 0.92,
          title: { text: 'Strike Rate', font: { size: 11, color: srColor }, standoff: 5 },
          tickfont: { color: srColor, size: 10 },
          range: [0, srMax * 1.3], showgrid: false,
        };
      }
    } else if (r === 'bowl') {
      layout[yName].title = { text: 'Bowling Average', font: { size: 11 }, standoff: 5 };
      layout[yName].range = [0, bowlMax * 1.3];
      const bWindowDesc = isLOI ? `${stintInns}-innings window` : `${stintSize}-match window`;
      const bMinDesc = isLOI ? `${stintInns} innings` : `10 bowling innings`;
      const sub = mobile
        ? `Per ${bWindowDesc} (min. ${bMinDesc}) \u2014 lower is better`
        : `Average for each ${bWindowDesc} (min. ${bMinDesc} to qualify) \u2014 lower is better`;
      layout.annotations.push({
        text: `<b>Bowling Average per Stint</b><br><span style="color:${mutedColor};font-size:${mobile ? 9 : 11}px">${sub}</span>`,
        xref: 'paper', yref: 'paper', x: 0.5, y: annoY, showarrow: false,
        font: { size: mobile ? 12 : 14, color: textColor },
      });

      if (isLOI && econVals && econVals.some(v => v != null)) {
        const econAxisName = `yaxis${axisMap['bowl'] * 10}`;
        const econMax = Math.max(...econVals.filter(v => v != null), 3);
        layout[econAxisName] = {
          gridcolor: 'rgba(0,0,0,0)', domain: domains[ri],
          anchor: 'free', overlaying: n === 1 ? 'y' : `y${n}`,
          side: 'right', position: 0.92,
          title: { text: 'Economy', font: { size: 11, color: '#FF6692' }, standoff: 5 },
          tickfont: { color: '#FF6692', size: 10 },
          range: [0, econMax * 1.3], showgrid: false,
        };
      }
    }
  }

  Plotly.newPlot('chart-player-career', traces, layout, plotlyConfig);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function simpleKDE(values, nPoints = 150) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  const bw = 1.06 * std * Math.pow(n, -0.2) * 1.2;

  const lo = Math.max(0, Math.min(...values) - 3 * bw);
  const hi = Math.max(...values) + 3 * bw;
  const step = (hi - lo) / (nPoints - 1);

  const x = [], y = [];
  for (let i = 0; i < nPoints; i++) {
    const xi = lo + i * step;
    let density = 0;
    for (const v of values) {
      const u = (xi - v) / bw;
      density += Math.exp(-0.5 * u * u);
    }
    density /= (n * bw * Math.sqrt(2 * Math.PI));
    x.push(Math.round(xi * 100) / 100);
    y.push(Math.round(density * 1e6) / 1e6);
  }
  return { x, y };
}

// ─── Cross-Format Rendering ─────────────────────────────────────────────

function renderCrossFormatAll() {
  if (!CROSS_FORMAT_DATA) return;

  const dates = ['tests', 'odis', 't20is'].map(f => ALL_DATA[f]?.metadata?.last_updated).filter(Boolean);
  const latest = dates.sort().pop();
  if (latest) {
    const d = new Date(latest);
    document.getElementById('last-updated').textContent = `Last updated: ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  }
  document.getElementById('player-count').textContent =
    `${CROSS_FORMAT_DATA.all3.batting.length} players`;

  const fmtLabels = { tests: 'Tests', odis: 'ODIs', t20is: 'T20Is' };
  const activeFmts = [];
  if (TUNE_PARAMS.xfTests > 0) activeFmts.push('tests');
  if (TUNE_PARAMS.xfOdis > 0) activeFmts.push('odis');
  if (TUNE_PARAMS.xfT20is > 0) activeFmts.push('t20is');
  const fmtStr = activeFmts.map(f => fmtLabels[f]).join(' + ');

  document.getElementById('heading-allrounders').textContent = 'Cross-Format Allrounder GOATs';
  document.querySelector('#panel-allrounders .panel-desc').textContent =
    `Ranked by geometric mean of weighted ${fmtStr} batting and bowling ratings. Players need both ratings above ${XF_MIN_AR} to qualify.`;

  document.getElementById('heading-batting').textContent = 'Cross-Format Batting GOATs';
  document.querySelector('#panel-batting .panel-desc').textContent =
    `Ranked by weighted ${fmtStr} batting rating.`;

  document.getElementById('heading-bowling').textContent = 'Cross-Format Bowling GOATs';
  document.querySelector('#panel-bowling .panel-desc').textContent =
    `Ranked by weighted ${fmtStr} bowling rating.`;

  renderXFCategory('allrounders', 'ar_total', CROSS_FORMAT_DATA.all3.allrounders, true);
  renderXFCategory('batting', 'bat_total', CROSS_FORMAT_DATA.all3.batting, false);
  renderXFCategory('bowling', 'bowl_total', CROSS_FORMAT_DATA.all3.bowling, false);

  renderCrossFormatMethodology();
}

function renderXFCategory(category, ratingKey, data, isAR) {
  const tableContainer = document.getElementById(`table-${category}`);
  const chartContainer = document.getElementById(`chart-${category}`);
  const prefix = category === 'batting' ? 'bat' : 'bowl';

  const fmtLabels = { tests: 'Tests', odis: 'ODIs', t20is: 'T20Is' };
  const activeFmts = [];
  if (TUNE_PARAMS.xfTests > 0) activeFmts.push('tests');
  if (TUNE_PARAMS.xfOdis > 0) activeFmts.push('odis');
  if (TUNE_PARAMS.xfT20is > 0) activeFmts.push('t20is');
  const fmtKeys = activeFmts.map(f => ({ key: `${prefix}_${f}`, label: fmtLabels[f] }));
  const titleParts = activeFmts.map(f => fmtLabels[f]).join(' + ');

  let tableHTML = `<h3 class="xf-section-title">${titleParts} <span class="xf-count">\u2014 ${data.length} players</span></h3>`;
  tableHTML += renderXFRows(data.slice(0, 25), ratingKey, isAR ? null : fmtKeys, isAR);
  tableContainer.innerHTML = tableHTML;

  const cid = `xf-chart-${category}`;
  chartContainer.innerHTML = `<div id="${cid}"></div>`;

  if (isAR) {
    renderXFArChart(cid, data);
  } else {
    renderXFStackedChart(cid, data, prefix);
  }
}

function renderXFRows(players, ratingKey, fmtKeys, isAR) {
  return players.map((p, i) => {
    const breakdown = isAR
      ? `Bat: ${p.bat_total} \u00b7 Bowl: ${p.bowl_total}`
      : fmtKeys.map(f => `${f.label}: ${p[f.key]}`).join(' \u00b7 ');
    return `
      <div class="lb-row ${medalClass(i)}">
        <div class="lb-rank">${String(i + 1).padStart(2, '0')}</div>
        <div class="lb-flag">${getFlag(p.country)}</div>
        <div class="lb-info">
          <div class="lb-name">${p.name}</div>
          <div class="lb-country">${p.country}</div>
          <div class="xf-breakdown">${breakdown}</div>
        </div>
        <div class="lb-primary">
          <div class="lb-primary-val">${p[ratingKey]}</div>
          <div class="lb-primary-label">Rating</div>
        </div>
      </div>`;
  }).join('');
}

function renderXFStackedChart(divId, players, prefix) {
  const mobile = isMobile();
  const n = mobile ? 15 : 25;
  const top = players.slice(0, n).reverse();
  const labels = top.map(p => mobile ? p.name.split(' ').pop() : `${getFlag(p.country)} ${p.name}`);

  const fmtConfig = [
    { key: 'tests', label: 'Tests', color: XF_COLORS.tests, weight: TUNE_PARAMS.xfTests },
    { key: 'odis', label: 'ODIs', color: XF_COLORS.odis, weight: TUNE_PARAMS.xfOdis },
    { key: 't20is', label: 'T20Is', color: XF_COLORS.t20is, weight: TUNE_PARAMS.xfT20is },
  ];
  const traces = fmtConfig.filter(f => f.weight > 0).map(f => ({
    y: labels, x: top.map(p => p[`${prefix}_${f.key}`] || 0),
    type: 'bar', orientation: 'h', name: f.label,
    marker: { color: f.color },
    text: top.map(p => { const v = p[`${prefix}_${f.key}`]; return v > 0 ? v : ''; }),
    textposition: 'inside', textfont: { color: '#fff', size: mobile ? 9 : 11 },
    hovertemplate: `%{y}<br>${f.label}: %{x}<extra></extra>`,
  }));

  Plotly.newPlot(divId, traces, plotlyLayout({
    barmode: 'stack',
    height: Math.max(mobile ? 400 : 550, top.length * (mobile ? 26 : 30) + 80),
    margin: { l: mobile ? 100 : 220, r: mobile ? 10 : 60, t: 10, b: 30 },
    xaxis: { title: 'Combined Rating' },
    yaxis: { tickfont: { size: mobile ? 10 : 12 } },
    legend: { orientation: 'h', y: 1.05, x: 0.5, xanchor: 'center' },
  }), plotlyConfig);
}

function renderXFArChart(divId, players) {
  const mobile = isMobile();
  const n = mobile ? 15 : 25;
  const top = players.slice(0, n).reverse();
  const labels = top.map(p => mobile ? p.name.split(' ').pop() : `${getFlag(p.country)} ${p.name}`);

  Plotly.newPlot(divId, [{
    y: labels, x: top.map(p => p.ar_total), type: 'bar', orientation: 'h',
    marker: { color: top.map(p => p.ar_total >= 2000 ? COLORS.aei : COLORS.bat) },
    text: top.map(p => p.ar_total), textposition: 'inside',
    textfont: { color: '#fff', size: mobile ? 10 : 12, weight: 700 },
    hovertemplate: '%{y}<br>AR Rating: %{x}<br>Bat: %{customdata[0]} \u00b7 Bowl: %{customdata[1]}<extra></extra>',
    customdata: top.map(p => [p.bat_total, p.bowl_total]),
  }], plotlyLayout({
    height: Math.max(mobile ? 400 : 550, top.length * (mobile ? 26 : 30) + 80),
    margin: { l: mobile ? 100 : 220, r: mobile ? 10 : 60, t: 10, b: 30 },
    xaxis: { title: 'Rating' },
    yaxis: { tickfont: { size: mobile ? 10 : 12 } },
    showlegend: false,
  }), plotlyConfig);
}

function renderCrossFormatMethodology() {
  const el = document.getElementById('methodology-content');
  if (!el) return;

  const t = TUNE_PARAMS.xfTests, o = TUNE_PARAMS.xfOdis, i = TUNE_PARAMS.xfT20is;
  const sum = t + o + i || 1;
  const pctT = Math.round(t / sum * 100), pctO = Math.round(o / sum * 100), pctI = Math.round(i / sum * 100);
  const activeFmts = [];
  if (t > 0) activeFmts.push('Tests');
  if (o > 0) activeFmts.push('ODIs');
  if (i > 0) activeFmts.push('T20Is');
  const fmtStr = activeFmts.join(' + ');

  const weightParts = [];
  if (t > 0) weightParts.push(`${pctT}% Tests`);
  if (o > 0) weightParts.push(`${pctO}% ODIs`);
  if (i > 0) weightParts.push(`${pctI}% T20Is`);
  const weightStr = weightParts.join(', ');

  const formulaParts = [];
  if (t > 0) formulaParts.push(`w<sub>T</sub> \u00d7 Test rating`);
  if (o > 0) formulaParts.push(`w<sub>O</sub> \u00d7 ODI rating`);
  if (i > 0) formulaParts.push(`w<sub>I</sub> \u00d7 T20I rating`);
  const formulaStr = formulaParts.join(' + ');

  el.innerHTML = `
    <h2>Cross-Format Methodology</h2>

    <h3>Concept</h3>
    <p>The Cross-Format GOAT rankings identify the greatest cricketers across multiple international formats. Each format's rating is computed independently using its own formula and tunable parameters, then combined using a <strong>weighted average</strong>.</p>

    <h3>Qualification</h3>
    <p>A player must appear in the individual rankings for every format with non-zero weight (currently: ${fmtStr}) \u2014 meaning they met the minimum match and innings thresholds in each format independently.</p>

    <h3>Format Weights</h3>
    <p>The current weighting is <strong>${weightStr}</strong>. Weights are normalized to sum to 100%, so the combined rating is a weighted average rather than a raw sum. You can adjust these weights using the segmented bar at the top of the tune panel.</p>

    <h3>Batting GOAT</h3>
    <div class="formula">Combined Batting Rating = ${formulaStr}</div>
    <p>Each format's batting rating is computed independently using the career formula (quality \u00d7 longevity \u00d7 pitch adjustment) with pitch difficulty normalization. The per-format batting parameters (longevity, pitch difficulty, not-out correction, strike rate weight) can be tuned independently. The weighted average rewards players who excelled across formats proportional to each format's assigned importance.</p>

    <h3>Bowling GOAT</h3>
    <div class="formula">Combined Bowling Rating = ${formulaStr}</div>
    <p>Same principle as batting. Each format's bowling rating uses its own tunable parameters (longevity, pitch, SR vs economy, etc.) and the results are combined with the same format weights.</p>

    <h3>Allrounder GOAT</h3>
    <div class="formula">Combined AR Rating = \u221a(Combined Bat Rating \u00d7 Combined Bowl Rating)</div>
    <p>The geometric mean of combined batting and bowling ratings rewards players who contributed significantly with <strong>both</strong> bat and ball across formats. A player must have a combined batting rating of at least <strong>${XF_MIN_AR}</strong> and a combined bowling rating of at least <strong>${XF_MIN_AR}</strong> to qualify.</p>

    <h3>Why Weighted Average?</h3>
    <p>Weights are normalized so the combined rating is always on the same scale as individual format ratings (roughly 0\u20131000+). This means a combined rating of 900 is comparable to a single-format rating of 900. Setting a format to 0% excludes it entirely, letting you create custom combinations like Tests + ODIs only.</p>
  `;
}

// ─── Tab Navigation ─────────────────────────────────────────────────────────

function switchTab(tabId, updateHash = true) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById(`panel-${tabId}`).classList.add('active');

  const showBat = tabId !== 'bowling';
  const showBowl = tabId !== 'batting';
  const isAR = tabId === 'allrounders';
  const hideTune = tabId === 'greatest-xi' || tabId === 'methodology';
  document.querySelectorAll('.tune-bat-only').forEach(el => el.classList.toggle('hidden', !showBat));
  document.querySelectorAll('.tune-bowl-only').forEach(el => el.classList.toggle('hidden', !showBowl));
  document.querySelectorAll('.tune-ar-header').forEach(el => el.classList.toggle('hidden', !isAR));
  const tunePanel = document.getElementById('tune-panel');
  if (tunePanel) tunePanel.style.display = hideTune ? 'none' : '';
  syncSlidersToParams();
  updateSrRowVisibility();

  if (updateHash) {
    history.pushState(null, '', `#${CURRENT_FORMAT}/${tabId}`);
  }

  setTimeout(() => {
    const panel = document.getElementById(`panel-${tabId}`);
    panel.querySelectorAll('.chart-container > .js-plotly-plot').forEach(el => {
      Plotly.Plots.resize(el);
    });
  }, 80);
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

// ─── Theme Toggle ───────────────────────────────────────────────────────────

function setupTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    if (DATA) renderAll();
  });
}

// ─── Tune Panel ─────────────────────────────────────────────────────────────

function _tuneStatusText(key, v) {
  const d = TUNE_DEFAULTS[key];
  const isDefault = v === d;
  if (key === 'batLongevity' || key === 'bowlLongevity') {
    if (v === 0) return 'Career length ignored — pure peak performance';
    if (v <= 0.15) return 'Career length barely matters';
    if (v <= 0.3) return isDefault ? 'Balanced (default)' : 'Moderate weight to career length';
    if (v <= 0.45) return 'Long careers strongly rewarded';
    return 'Career length dominates rankings';
  }
  if (key === 'batPitch' || key === 'bowlPitch') {
    if (v === 0) return 'Raw stats only — no pitch corrections';
    if (v <= 0.3) return 'Mild adjustment for conditions';
    if (v <= 0.6) return isDefault ? 'Moderate correction (default)' : 'Moderate correction for conditions';
    if (v <= 0.8) return 'Heavy adjustment for conditions';
    return 'Full pitch normalization applied';
  }
  if (key === 'alpha') {
    if (v === 0) return 'Trust traditional averages fully';
    if (v <= 0.2) return 'Slight not-out correction';
    if (v <= 0.4) return isDefault ? 'Balanced correction (default)' : 'Moderate correction';
    if (v <= 0.6) return 'Strong not-out penalty for high N.O. rates';
    return 'Almost entirely using runs per innings';
  }
  if (key === 'srWeight') {
    if (v === 0) return 'Strike rate ignored — pure run-scoring';
    if (v <= 0.5) return 'Minor strike rate bonus';
    if (v <= 1.1) return isDefault ? 'Equal weight to SR & avg (default)' : 'Moderate strike rate influence';
    if (v <= 1.5) return 'Fast scorers significantly rewarded';
    return 'Strike rate dominates the batting score';
  }
  if (key === 'bowlSrWeight') {
    if (v === 0) return 'Only economy matters — pure run prevention';
    if (v <= 0.2) return 'Economy-focused — SR barely matters';
    if (v <= 0.4) return 'Economy weighted slightly more than SR';
    if (v <= 0.6) return isDefault ? 'Balanced — SR and economy equal (default)' : 'Balanced — SR and economy roughly equal';
    if (v <= 0.8) return 'SR weighted more — reward frequent breakthroughs';
    return 'Only SR matters — pure wicket-taking ability';
  }
  if (key === 'bowlAvgW') {
    if (v === 0) return 'Bowling average ignored entirely';
    if (v <= 0.4) return 'Average barely matters';
    if (v <= 0.8) return 'Average matters somewhat';
    if (v <= 1.2) return isDefault ? 'Standard weight to average (default)' : 'Standard weight to average';
    if (v <= 1.6) return 'Low averages strongly rewarded';
    return 'Average dominates — miserly bowlers rank highest';
  }
  if (key === 'wpiWeight') {
    if (v === 0) return 'Ignore wickets per innings — pure bowling average';
    if (v <= 0.2) return 'Wickets per innings barely matters';
    if (v <= 0.4) return 'Slight reward for high WPI';
    if (v <= 0.6) return isDefault ? 'Moderate weight to WPI (default)' : 'Moderate weight to wickets per innings';
    if (v <= 0.8) return 'High WPI strongly rewarded';
    return 'Wickets per innings dominates';
  }
  return '';
}

function setupTunePanel() {
  const toggle = document.getElementById('tune-toggle');
  const body = document.getElementById('tune-body');
  const arrow = document.getElementById('tune-arrow');
  const resetBtn = document.getElementById('tune-reset');
  const shareBtn = document.getElementById('tune-share');

  toggle.addEventListener('click', () => {
    body.classList.toggle('hidden');
    arrow.classList.toggle('open');
  });

  const sliderKeys = ['batLongevity', 'bowlLongevity', 'batPitch', 'bowlPitch', 'alpha', 'srWeight', 'bowlSrWeight', 'wpiWeight', 'bowlAvgW'];
  for (const key of sliderKeys) {
    const slider = document.getElementById(`tune-${key}`);
    const statusEl = document.getElementById(`tune-${key}-status`);
    const valEl = document.getElementById(`tune-${key}-val`);
    slider.addEventListener('input', () => {
      const pct = parseInt(slider.value, 10);
      const real = _sliderToReal(key, pct);
      activeParams()[key] = real;
      if (valEl) valEl.textContent = pct;
      if (statusEl) {
        statusEl.textContent = _tuneStatusText(key, real);
        statusEl.classList.toggle('changed', real !== TUNE_DEFAULTS[key]);
      }
      onTuneChange();
    });
  }

  resetBtn.addEventListener('click', () => {
    resetParams();
    syncSlidersToParams();
    syncXfSliders();
    if (CURRENT_FORMAT === 'crossformat') computeCrossFormat();
    updateTuneBadge();
    renderAll();
  });

  function handleSectionReset(keys) {
    resetParamsSection(keys);
    syncSlidersToParams();
    syncXfSliders();
    recomputeRankings();
    if (CURRENT_FORMAT === 'crossformat') computeCrossFormat();
    updateTuneBadge();
    renderAll();
  }
  document.getElementById('reset-bat').addEventListener('click', () => handleSectionReset(BAT_PARAM_KEYS));
  document.getElementById('reset-bowl').addEventListener('click', () => handleSectionReset(BOWL_PARAM_KEYS));

  shareBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const params = encodeTuneParams();
    const base = `${location.origin}${location.pathname}#${CURRENT_FORMAT}/allrounders`;
    const url = params ? `${base}?${params}` : base;
    navigator.clipboard.writeText(url).then(() => {
      shareBtn.textContent = 'Link Copied!';
      setTimeout(() => { shareBtn.textContent = 'Copy Link to This Config'; }, 2000);
    }).catch(() => {
      prompt('Copy this URL:', url);
    });
  });

  for (const [fmt, keys] of Object.entries(XF_PARAM_KEYS)) {
    for (const key of keys) {
      const id = `tune-xf-${fmt}-${key}`;
      const slider = document.getElementById(id);
      const statusEl = document.getElementById(`${id}-status`);
      const valEl = document.getElementById(`${id}-val`);
      if (!slider) continue;
      slider.addEventListener('input', () => {
        const pct = parseInt(slider.value, 10);
        const real = _sliderToReal(key, pct);
        XF_TUNE_PARAMS[fmt][key] = real;
        if (valEl) valEl.textContent = pct;
        if (statusEl) {
          statusEl.textContent = _tuneStatusText(key, real);
          statusEl.classList.toggle('changed', real !== XF_TUNE_DEFAULTS[fmt][key]);
        }
        onTuneChange();
      });
    }
  }
}

function syncXfSliders() {
  for (const [fmt, keys] of Object.entries(XF_PARAM_KEYS)) {
    for (const key of keys) {
      const id = `tune-xf-${fmt}-${key}`;
      const slider = document.getElementById(id);
      const statusEl = document.getElementById(`${id}-status`);
      const valEl = document.getElementById(`${id}-val`);
      const v = XF_TUNE_PARAMS[fmt][key];
      const pct = _realToSlider(key, v);
      if (slider) slider.value = pct;
      if (valEl) valEl.textContent = pct;
      if (statusEl) {
        statusEl.textContent = _tuneStatusText(key, v);
        statusEl.classList.toggle('changed', v !== XF_TUNE_DEFAULTS[fmt][key]);
      }
    }
  }
  updateXfWeightBar();
}

function updateXfWeightBar() {
  const bar = document.getElementById('xf-weight-bar');
  if (!bar) return;
  const t = TUNE_PARAMS.xfTests, o = TUNE_PARAMS.xfOdis, i = TUNE_PARAMS.xfT20is;
  const segT = document.getElementById('xf-seg-tests');
  const segO = document.getElementById('xf-seg-odis');
  const segI = document.getElementById('xf-seg-t20is');
  if (segT) { segT.style.width = t + '%'; segT.querySelector('.xf-seg-label').textContent = t >= 12 ? `Tests ${t}%` : `${t}%`; }
  if (segO) { segO.style.width = o + '%'; segO.querySelector('.xf-seg-label').textContent = o >= 12 ? `ODIs ${o}%` : `${o}%`; }
  if (segI) { segI.style.width = i + '%'; segI.querySelector('.xf-seg-label').textContent = i >= 12 ? `T20Is ${i}%` : `${i}%`; }
  const div0 = document.getElementById('xf-div-0');
  const div1 = document.getElementById('xf-div-1');
  if (div0) div0.style.left = t + '%';
  if (div1) div1.style.left = (t + o) + '%';
}

function setupXfWeightBar() {
  const bar = document.getElementById('xf-weight-bar');
  if (!bar) return;
  const MIN_PCT = 0;

  function onDrag(divIdx, e) {
    const rect = bar.getBoundingClientRect();
    const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const pct = Math.round(Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100)));
    const t = TUNE_PARAMS.xfTests, o = TUNE_PARAMS.xfOdis, i = TUNE_PARAMS.xfT20is;

    if (divIdx === 0) {
      let newT = Math.max(MIN_PCT, Math.min(100 - i - MIN_PCT, pct));
      let newO = 100 - i - newT;
      if (newO < MIN_PCT) { newO = MIN_PCT; newT = 100 - i - MIN_PCT; }
      TUNE_PARAMS.xfTests = newT;
      TUNE_PARAMS.xfOdis = newO;
    } else {
      let boundary = pct;
      let newO = Math.max(MIN_PCT, boundary - t);
      let newI = 100 - t - newO;
      if (newI < MIN_PCT) { newI = MIN_PCT; newO = 100 - t - MIN_PCT; }
      TUNE_PARAMS.xfOdis = newO;
      TUNE_PARAMS.xfT20is = newI;
    }
    updateXfWeightBar();
    onTuneChange();
  }

  const dividers = [document.getElementById('xf-div-0'), document.getElementById('xf-div-1')];
  dividers.forEach((div, idx) => {
    if (!div) return;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      div.classList.add('dragging');
      const move = (ev) => onDrag(idx, ev);
      const up = () => { div.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    div.addEventListener('touchstart', (e) => {
      e.preventDefault();
      div.classList.add('dragging');
      const move = (ev) => onDrag(idx, ev);
      const up = () => { div.classList.remove('dragging'); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); };
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', up);
    });
  });

  updateXfWeightBar();
}

function onTuneChange() {
  if (CURRENT_FORMAT === 'crossformat') {
    const savedParams = { ...TUNE_PARAMS };
    for (const fmt of ['tests', 'odis', 't20is']) {
      if (!ALL_DATA[fmt] || !ORIGINAL_DATA[fmt]) continue;
      DATA = ALL_DATA[fmt];
      CURRENT_FORMAT = fmt;
      const xfP = XF_TUNE_PARAMS[fmt];
      TUNE_PARAMS = { ...TUNE_DEFAULTS, ...xfP };
      resetToOriginalData();
      recomputeRankings();
    }
    TUNE_PARAMS = savedParams;
    CURRENT_FORMAT = 'crossformat';
    DATA = null;
    computeCrossFormat();
    updateTuneBadge();
    renderAll();
    return;
  }
  if (!DATA) return;
  resetToOriginalData();
  recomputeRankings();
  updateTuneBadge();
  renderAll();
}

function resetToOriginalData() {
  if (!ORIGINAL_DATA[CURRENT_FORMAT]) return;
  const orig = ORIGINAL_DATA[CURRENT_FORMAT];
  DATA.all_players = JSON.parse(JSON.stringify(orig.all_players));
  DATA.metadata = { ...orig.metadata };
}

function syncSlidersToParams() {
  const keys = ['batLongevity', 'bowlLongevity', 'batPitch', 'bowlPitch', 'alpha', 'srWeight', 'bowlSrWeight', 'wpiWeight', 'bowlAvgW'];
  const p = activeParams();
  for (const key of keys) {
    const slider = document.getElementById(`tune-${key}`);
    const statusEl = document.getElementById(`tune-${key}-status`);
    const valEl = document.getElementById(`tune-${key}-val`);
    const pct = _realToSlider(key, p[key]);
    if (slider) slider.value = pct;
    if (valEl) valEl.textContent = pct;
    if (statusEl) {
      statusEl.textContent = _tuneStatusText(key, p[key]);
      statusEl.classList.toggle('changed', p[key] !== TUNE_DEFAULTS[key]);
    }
  }
  updateXfWeightBar();
  updateSrRowVisibility();
}

function updateSrRowVisibility() {
  const isTests = CURRENT_FORMAT === 'tests';
  const activeTab = document.querySelector('.tab.active');
  const tab = activeTab ? activeTab.dataset.tab : 'allrounders';
  const showBat = tab !== 'bowling';
  const showBowl = tab !== 'batting';

  const srRow = document.getElementById('tune-sr-row');
  const wpiRow = document.getElementById('tune-wpi-row');
  const bowlAvgRow = document.getElementById('tune-bowlAvg-row');
  if (srRow) srRow.classList.toggle('hidden', isTests || !showBat);
  if (wpiRow) wpiRow.classList.toggle('hidden', !isTests || !showBowl);
  if (bowlAvgRow) bowlAvgRow.classList.toggle('hidden', !isTests || !showBowl);
}

function updateTuneBadge() {
  const badge = document.getElementById('tune-badge');
  if (badge) badge.classList.toggle('hidden', !isCustomParams());
}

function encodeTuneParams() {
  const parts = [];
  for (const [k, def] of Object.entries(TUNE_DEFAULTS)) {
    if (TUNE_PARAMS[k] !== def) {
      parts.push(`${k}=${TUNE_PARAMS[k]}`);
    }
  }
  for (const [k, def] of Object.entries(TUNE_DEFAULTS)) {
    if (AR_TUNE_PARAMS[k] !== def) {
      parts.push(`ar_${k}=${AR_TUNE_PARAMS[k]}`);
    }
  }
  for (const [fmt, keys] of Object.entries(XF_PARAM_KEYS)) {
    for (const key of keys) {
      if (XF_TUNE_PARAMS[fmt][key] !== XF_TUNE_DEFAULTS[fmt][key]) {
        parts.push(`xf_${fmt}_${key}=${XF_TUNE_PARAMS[fmt][key]}`);
      }
    }
  }
  return parts.join('&');
}

function decodeTuneParams(qs) {
  if (!qs) return;
  const pairs = qs.split('&');
  for (const pair of pairs) {
    const [k, v] = pair.split('=');
    if (!k || !v) continue;
    const xfMatch = k.match(/^xf_(tests|odis|t20is)_(.+)$/);
    const arMatch = k.match(/^ar_(.+)$/);
    if (xfMatch) {
      const [, fmt, param] = xfMatch;
      if (XF_TUNE_PARAMS[fmt] && param in XF_TUNE_PARAMS[fmt]) {
        XF_TUNE_PARAMS[fmt][param] = parseFloat(v);
      }
    } else if (arMatch) {
      const param = arMatch[1];
      if (param in TUNE_DEFAULTS) {
        AR_TUNE_PARAMS[param] = parseFloat(v);
      }
    } else if (k in TUNE_DEFAULTS) {
      TUNE_PARAMS[k] = parseFloat(v);
    }
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

// ─── Greatest XI ─────────────────────────────────────────────────────────────

const XI_TEMPLATE = [
  { role: 'opener', label: 'Opener' },
  { role: 'opener', label: 'Opener' },
  { role: 'middle', label: 'Middle Order' },
  { role: 'middle', label: 'Middle Order' },
  { role: 'middle', label: 'Middle Order' },
  { role: 'allrounder', label: 'Allrounder' },
  { role: 'keeper', label: 'Keeper' },
  { role: 'spinner', label: 'Spinner' },
  { role: 'spinner', label: 'Spinner' },
  { role: 'fast', label: 'Fast Bowler' },
  { role: 'fast', label: 'Fast Bowler' },
];

let CURRENT_XI = new Array(11).fill(null);
let _xiEditingSlot = -1;

function generateDefaultXI() {
  const players = DATA.all_players;
  const used = new Set();
  const xi = new Array(11).fill(null);

  for (let i = 0; i < XI_TEMPLATE.length; i++) {
    const { role } = XI_TEMPLATE[i];
    let candidates;
    if (role === 'opener' || role === 'middle' || role === 'keeper') {
      candidates = [...players]
        .filter(p => p.playing_role === role && !used.has(p.name) && p.bat_rating > 0)
        .sort((a, b) => b.bat_rating - a.bat_rating);
    } else if (role === 'allrounder') {
      candidates = [...players]
        .filter(p => p.playing_role === role && !used.has(p.name) && p.ar_rating > 0)
        .sort((a, b) => (b.ar_rating || 0) - (a.ar_rating || 0));
    } else {
      candidates = [...players]
        .filter(p => p.playing_role === role && !used.has(p.name) && p.bowl_rating > 0)
        .sort((a, b) => b.bowl_rating - a.bowl_rating);
    }
    if (candidates.length > 0) {
      xi[i] = candidates[0];
      used.add(candidates[0].name);
    }
  }
  return xi;
}

function _ratingForRole(player, role) {
  if (role === 'allrounder') return player.ar_rating || 0;
  if (role === 'spinner' || role === 'fast') return player.bowl_rating || 0;
  return player.bat_rating || 0;
}

function addToXI(playerName, targetSlot) {
  const player = DATA.all_players.find(p => p.name === playerName);
  if (!player) return;
  if (CURRENT_XI.some(p => p && p.name === playerName)) return;

  if (targetSlot != null && targetSlot >= 0 && targetSlot < 11) {
    CURRENT_XI[targetSlot] = player;
  } else {
    const role = player.playing_role;
    let idx = -1;
    if (role) {
      idx = CURRENT_XI.findIndex((p, i) => !p && XI_TEMPLATE[i].role === role);
    }
    if (idx < 0) {
      idx = CURRENT_XI.findIndex(p => !p);
    }
    if (idx < 0 && role) {
      let worstIdx = -1, worstRating = Infinity;
      CURRENT_XI.forEach((p, i) => {
        if (p && XI_TEMPLATE[i].role === role) {
          const r = _ratingForRole(p, role);
          if (r < worstRating) { worstRating = r; worstIdx = i; }
        }
      });
      if (worstIdx >= 0 && _ratingForRole(player, role) > worstRating) {
        idx = worstIdx;
      }
    }
    if (idx < 0) {
      let worstIdx = -1, worstRating = Infinity;
      CURRENT_XI.forEach((p, i) => {
        if (p) {
          const r = _ratingForRole(p, XI_TEMPLATE[i].role);
          if (r < worstRating) { worstRating = r; worstIdx = i; }
        }
      });
      idx = worstIdx;
    }
    if (idx >= 0) CURRENT_XI[idx] = player;
  }
  renderGreatestXI();
}

function removeFromXI(playerName) {
  const idx = CURRENT_XI.findIndex(p => p && p.name === playerName);
  if (idx >= 0) {
    CURRENT_XI[idx] = null;
    return true;
  }
  return false;
}

function xiPlayerStats(p) {
  const parts = [];
  if (p.bat_rating > 0) parts.push(`Bat ${p.bat_rating}`);
  if (p.bowl_rating > 0) parts.push(`Bowl ${p.bowl_rating}`);
  if (p.career_bat_avg != null) parts.push(`Avg ${p.career_bat_avg.toFixed(1)}`);
  return parts.join(' · ');
}

function renderGreatestXI() {
  const container = document.getElementById('xi-slots');
  if (!container) return;

  const formatLabel = { tests: 'Test', odis: 'ODI', t20is: 'T20I', ipl: 'IPL' }[CURRENT_FORMAT] || 'Test';
  const heading = document.getElementById('heading-xi');
  if (heading) heading.textContent = `Greatest ${formatLabel} XI`;

  container.innerHTML = CURRENT_XI.map((player, i) => {
    const tmpl = XI_TEMPLATE[i];
    const num = String(i + 1).padStart(2, '\u2007');
    if (player) {
      return `
        <div class="xi-slot" data-slot="${i}">
          <span class="xi-slot-num">${num}</span>
          <span class="xi-slot-role">${tmpl.label}</span>
          <div class="xi-slot-player">
            <span class="xi-slot-flag">${getFlag(player.country)}</span>
            <span>${player.name}</span>
          </div>
          <span class="xi-slot-stats">${xiPlayerStats(player)}</span>
          <button class="xi-slot-remove" data-slot="${i}" title="Remove">&times;</button>
        </div>`;
    } else {
      return `
        <div class="xi-slot xi-slot-empty" data-slot="${i}">
          <span class="xi-slot-num">${num}</span>
          <span class="xi-slot-role">${tmpl.label}</span>
          <span class="xi-slot-empty-text">Click to add a ${tmpl.label.toLowerCase()}</span>
        </div>`;
    }
  }).join('');

  container.querySelectorAll('.xi-slot-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slot = parseInt(btn.dataset.slot);
      CURRENT_XI[slot] = null;
      renderGreatestXI();
    });
  });

  container.querySelectorAll('.xi-slot').forEach(el => {
    el.addEventListener('click', () => {
      const slot = parseInt(el.dataset.slot);
      if (CURRENT_XI[slot]) return;
      startXiSlotSearch(slot);
    });
  });

  renderXiSummary();
}

function startXiSlotSearch(slot) {
  _xiEditingSlot = slot;
  const container = document.getElementById('xi-slots');
  const slotEl = container.querySelector(`.xi-slot[data-slot="${slot}"]`);
  if (!slotEl) return;

  slotEl.classList.add('xi-slot-editing');
  const tmpl = XI_TEMPLATE[slot];
  slotEl.innerHTML = `
    <span class="xi-slot-num">${String(slot + 1).padStart(2, '\u2007')}</span>
    <span class="xi-slot-role">${tmpl.label}</span>
    <input class="xi-slot-inline-search" type="text" placeholder="Type a player name..." autofocus autocomplete="off">
  `;

  const input = slotEl.querySelector('.xi-slot-inline-search');
  const resultsEl = document.getElementById('xi-search-results');
  input.focus();

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q.length < 2) { resultsEl.classList.remove('open'); return; }
    showXiSearchResults(q, resultsEl, slot);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      resultsEl.classList.remove('open');
      _xiEditingSlot = -1;
      renderGreatestXI();
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      resultsEl.classList.remove('open');
      if (_xiEditingSlot === slot) {
        _xiEditingSlot = -1;
        renderGreatestXI();
      }
    }, 200);
  });
}

function showXiSearchResults(query, resultsEl, targetSlot) {
  const matches = searchPlayers(query);
  const usedNames = new Set(CURRENT_XI.filter(Boolean).map(p => p.name));
  const filtered = matches.filter(m => !usedNames.has(m.name));

  if (filtered.length === 0) {
    resultsEl.innerHTML = '<div class="xi-sr-item" style="color:var(--muted)">No players found</div>';
    resultsEl.classList.add('open');
    return;
  }

  resultsEl.innerHTML = filtered.slice(0, 10).map(p => `
    <div class="xi-sr-item" data-name="${p.name}">
      <span>${getFlag(p.country)}</span>
      <span>${p.name}</span>
      ${p.playing_role ? `<span class="xi-sr-role">${p.playing_role}</span>` : ''}
      <span class="xi-sr-stats">${xiPlayerStats(p)}</span>
    </div>
  `).join('');

  resultsEl.classList.add('open');
  resultsEl.querySelectorAll('.xi-sr-item[data-name]').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const name = el.dataset.name;
      _xiEditingSlot = -1;
      resultsEl.classList.remove('open');
      addToXI(name, targetSlot);
    });
  });
}

function renderXiSummary() {
  const el = document.getElementById('xi-summary');
  if (!el) return;
  const filled = CURRENT_XI.filter(Boolean);
  if (filled.length === 0) { el.innerHTML = ''; return; }

  const avgBat = filled.filter(p => p.bat_rating > 0).reduce((s, p) => s + p.bat_rating, 0) / Math.max(1, filled.filter(p => p.bat_rating > 0).length);
  const avgBowl = filled.filter(p => p.bowl_rating > 0).reduce((s, p) => s + p.bowl_rating, 0) / Math.max(1, filled.filter(p => p.bowl_rating > 0).length);
  const countries = [...new Set(filled.map(p => p.country))];

  el.innerHTML = `
    <strong>${filled.length}/11</strong> players selected · 
    Avg batting rating: <strong>${Math.round(avgBat)}</strong> · 
    Avg bowling rating: <strong>${Math.round(avgBowl)}</strong> · 
    ${countries.length} ${countries.length === 1 ? 'country' : 'countries'} represented: ${countries.map(c => getFlag(c)).join(' ')}
  `;
}

function setupGreatestXI() {
  const mainSearch = document.getElementById('xi-search');
  const mainResults = document.getElementById('xi-search-results');
  if (!mainSearch || !mainResults) return;

  mainSearch.addEventListener('input', () => {
    const q = mainSearch.value.trim();
    if (q.length < 2) { mainResults.classList.remove('open'); return; }
    showXiSearchResults(q, mainResults, undefined);
  });

  mainSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      mainResults.classList.remove('open');
      mainSearch.value = '';
    }
    if (e.key === 'Enter') {
      const matches = searchPlayers(mainSearch.value.trim());
      const usedNames = new Set(CURRENT_XI.filter(Boolean).map(p => p.name));
      const pick = matches.find(m => !usedNames.has(m.name));
      if (pick) {
        addToXI(pick.name);
        mainSearch.value = '';
        mainResults.classList.remove('open');
      }
    }
  });

  document.getElementById('xi-reset').addEventListener('click', () => {
    CURRENT_XI = generateDefaultXI();
    renderGreatestXI();
  });

  document.getElementById('xi-copy-link').addEventListener('click', () => {
    const names = CURRENT_XI.map(p => p ? encodeURIComponent(p.name) : '').join(',');
    const url = `${location.origin}${location.pathname}#${CURRENT_FORMAT}/greatest-xi/p=${names}`;
    navigator.clipboard.writeText(url).then(() => {
      const toast = document.createElement('div');
      toast.className = 'xi-copied-toast';
      toast.textContent = 'Link copied!';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2200);
    });
  });
}

function encodeXiInHash() {
  const names = CURRENT_XI.map(p => p ? encodeURIComponent(p.name) : '').join(',');
  return `p=${names}`;
}

function decodeXiFromHash(str) {
  if (!str.startsWith('p=')) return;
  const names = str.slice(2).split(',').map(s => decodeURIComponent(s));
  for (let i = 0; i < 11 && i < names.length; i++) {
    if (names[i]) {
      const player = DATA.all_players.find(p => p.name === names[i]);
      CURRENT_XI[i] = player || null;
    } else {
      CURRENT_XI[i] = null;
    }
  }
}

function setupFormatBar() {
  document.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => switchFormat(btn.dataset.format));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupFormatBar();
  setupTabs();
  setupSearch();
  setupTunePanel();
  setupXfWeightBar();
  setupGreatestXI();
  loadData();

  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    const newWidth = window.innerWidth;
    if (newWidth !== lastWidth) {
      lastWidth = newWidth;
      if (DATA) renderAll();
    }
  });

  window.addEventListener('popstate', () => {
    if (DATA) restoreFromHash();
  });
});
