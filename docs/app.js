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

  const playerMap = {};
  for (const [key, data] of [['tests', tests], ['odis', odis], ['t20is', t20is]]) {
    for (const p of data.all_players) {
      if (!playerMap[p.name]) playerMap[p.name] = {};
      playerMap[p.name][key] = p;
    }
  }

  const all3 = { batting: [], bowling: [], allrounders: [] };
  const testOdi = { batting: [], bowling: [], allrounders: [] };

  for (const [name, fmts] of Object.entries(playerMap)) {
    if (fmts.tests && fmts.odis && fmts.t20is) {
      const bat = fmts.tests.bat_rating + fmts.odis.bat_rating + fmts.t20is.bat_rating;
      const bowl = fmts.tests.bowl_rating + fmts.odis.bowl_rating + fmts.t20is.bowl_rating;
      const entry = {
        name, country: fmts.tests.country, bat_total: bat, bowl_total: bowl,
        bat_tests: fmts.tests.bat_rating, bat_odis: fmts.odis.bat_rating, bat_t20is: fmts.t20is.bat_rating,
        bowl_tests: fmts.tests.bowl_rating, bowl_odis: fmts.odis.bowl_rating, bowl_t20is: fmts.t20is.bowl_rating,
        matches_tests: fmts.tests.matches, matches_odis: fmts.odis.matches, matches_t20is: fmts.t20is.matches,
      };
      if (bat > 0) all3.batting.push(entry);
      if (bowl > 0) all3.bowling.push(entry);
      if (bat >= XF_MIN_AR && bowl >= XF_MIN_AR) {
        entry.ar_total = Math.round(Math.sqrt(bat * bowl));
        all3.allrounders.push(entry);
      }
    }

    if (fmts.tests && fmts.odis) {
      const bat = fmts.tests.bat_rating + fmts.odis.bat_rating;
      const bowl = fmts.tests.bowl_rating + fmts.odis.bowl_rating;
      const entry = {
        name, country: fmts.tests.country, bat_total: bat, bowl_total: bowl,
        bat_tests: fmts.tests.bat_rating, bat_odis: fmts.odis.bat_rating,
        bowl_tests: fmts.tests.bowl_rating, bowl_odis: fmts.odis.bowl_rating,
        matches_tests: fmts.tests.matches, matches_odis: fmts.odis.matches,
      };
      if (bat > 0) testOdi.batting.push(entry);
      if (bowl > 0) testOdi.bowling.push(entry);
      if (bat >= XF_MIN_AR && bowl >= XF_MIN_AR) {
        entry.ar_total = Math.round(Math.sqrt(bat * bowl));
        testOdi.allrounders.push(entry);
      }
    }
  }

  for (const group of [all3, testOdi]) {
    group.batting.sort((a, b) => b.bat_total - a.bat_total);
    group.bowling.sort((a, b) => b.bowl_total - a.bowl_total);
    group.allrounders.sort((a, b) => b.ar_total - a.ar_total);
  }

  CROSS_FORMAT_DATA = { all3, testOdi };
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
    buildNameIndex();
    renderAll();
    restoreFromHash();
    document.body.classList.add('loaded');
    loadFormatData('odis');
    loadFormatData('t20is');
    loadFormatData('ipl');
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
    buildNameIndex();
    updateFormatLabels();
  }

  document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.format-btn[data-format="${format}"]`).classList.add('active');

  renderAll();

  const plTab = document.querySelector('.tab[data-tab="player-lookup"]');
  if (format === 'crossformat') {
    plTab.style.display = 'none';
    if (document.querySelector('.tab.active')?.dataset.tab === 'player-lookup') {
      switchTab('allrounders', false);
    }
  } else {
    plTab.style.display = '';
    document.getElementById('player-card').classList.add('hidden');
    document.getElementById('player-search').value = '';
  }

  const activeTab = document.querySelector('.tab.active');
  const tabId = activeTab ? activeTab.dataset.tab : 'allrounders';
  history.pushState(null, '', `#${format}/${tabId}`);
}

async function restoreFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return;
  const hash = decodeURIComponent(raw);

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
        renderAll();
      }
    } else {
      const data = await loadFormatData(format);
      if (data) {
        CURRENT_FORMAT = format;
        DATA = data;
        document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.format-btn[data-format="${format}"]`);
        if (btn) btn.classList.add('active');
        const plTab = document.querySelector('.tab[data-tab="player-lookup"]');
        if (plTab) plTab.style.display = '';
        buildNameIndex();
        updateFormatLabels();
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
    const validTabs = ['allrounders', 'batting', 'bowling', 'player-lookup', 'methodology'];
    if (validTabs.includes(rest)) {
      if (rest === 'player-lookup' && CURRENT_FORMAT === 'crossformat') {
        switchTab('allrounders', false);
      } else {
        switchTab(rest, false);
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
  document.querySelector('#panel-batting .panel-desc').textContent = `The greatest batsmen in ${label} cricket history, ranked by career batting excellence. Click any player to explore their career.`;
  document.querySelector('#panel-bowling .panel-desc').textContent = `The greatest bowlers in ${label} cricket history, ranked by career bowling excellence. Click any player to explore their career.`;
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

function playerSubtitle(p) {
  const isIPL = CURRENT_FORMAT === 'ipl';
  if (isIPL && p.franchises && p.franchises.length) {
    return `${franchiseBadges(p.franchises)} · ${p.matches} matches`;
  }
  return `${p.country} · ${p.matches} matches`;
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
    </div>
  `).join('');
  addRowClickHandlers(container);
}

function addRowClickHandlers(container) {
  container.querySelectorAll('.lb-row').forEach(row => {
    row.addEventListener('click', () => {
      const name = row.dataset.player;
      switchTab('player-lookup');
      document.getElementById('player-search').value = name;
      showPlayer(name);
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
        Batting factor = (All-time avg / Match avg) × (All-time RPO / Match RPO)<br>
        Bowling factor = (Match avg / All-time avg) × (Match RPO / All-time RPO)
      </div>
      <p>This captures both era effects <strong>and</strong> the specific venues and conditions a player faced. A batsman who played mostly on difficult, low-scoring pitches gets a boost. A bowler who benefited from seaming conditions gets a corresponding penalty. Home/away splits are indirectly accounted for.</p>`
    : `<p>For each player, we compute the <strong>overall batting average</strong> (total runs ÷ total wickets) across all Test matches they appeared in, and compare it to the all-time average (${m.all_time_avg}):</p>
      <div class="formula">
        Batting factor = All-time avg / Match avg<br>
        Bowling factor = Match avg / All-time avg
      </div>
      <p>A player who faced predominantly tough conditions (e.g., match avg = 28) gets a batting boost of ~1.14× and a bowling penalty of ~0.88×. A player whose matches were high-scoring (e.g., match avg = 34) gets a batting penalty of ~0.94× and a bowling boost of ~1.07×. This is strictly more granular than era-based normalization — it accounts for the specific grounds, pitch conditions, and opposition strength each player actually faced.</p>`;

  const arDesc = `<p>The AEI captures a player's combined contribution with bat and ball. However, allrounders are <strong>ranked by the geometric mean</strong> of their batting and bowling ratings — √(bat_rating × bowl_rating) — which naturally rewards <strong>balance</strong> between the two disciplines. A player who is elite in one but weak in the other will rank below someone who is very good in both. A player must achieve a minimum rating of <strong>${m.min_ar_rating}</strong> in both batting and bowling to qualify.</p>`;

  const arRankFormula = `AEI = BEI + BoEI<br>Ranking metric = √(bat_rating × bowl_rating)`;

  const longevityExp = m.longevity_exp || 0.3;

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
    <p>A career average tells you <em>how well</em> a player performed, but not <em>for how long</em>. A player who averages 45 at a strike rate of 130 over 30 ${label}s is not the same as one who sustains those numbers over 150 ${label}s. Our index rewards both quality and longevity.</p>

    <h3>Batting Excellence Index (BEI)</h3>
    <div class="formula">BEI = avg<sup>0.7</sup> × RPI<sup>0.3</sup> × (strike_rate / 100) × innings<sup>${longevityExp}</sup></div>
    <p>The batting quality metric uses a <strong>weighted geometric mean</strong> of the career average and runs per innings (RPI = runs ÷ innings). Career average (runs ÷ dismissals) rewards not-outs, while RPI measures raw per-innings production. The weighting (avg<sup>0.7</sup> × RPI<sup>0.3</sup>) applies a moderate not-out correction — a genuine match-winning 80* still gets substantial credit, but a finisher with a high average inflated by many low-scoring not-outs is tempered. This exponent (0.3) is uniform across all formats. The result is multiplied by <strong>SR/100</strong> to capture scoring speed — a player averaging 40 at a strike rate of 130 is far more valuable than one averaging 40 at 70. The <strong>innings<sup>${longevityExp}</sup></strong> exponent provides a controlled longevity bonus.</p>

    <h3>Bowling Excellence Index (BoEI)</h3>
    <div class="formula">BoEI = (${m.bowl_k} / (bowl_SR × economy / 6)) × innings<sup>${longevityExp}</sup> × scale</div>
    <p>In limited-overs cricket, a bowler's value comes from two independent factors: <strong>strike rate</strong> (balls per wicket — how quickly they take wickets) and <strong>economy rate</strong> (runs per over — how well they contain). Both are weighted equally. A data-driven scaling factor (×${m.boei_scale}) ensures that BEI and BoEI are on comparable scales. Bowlers must have at least <strong>20 bowling innings</strong> to qualify.</p>

    <h3>Pitch &amp; Era Normalization</h3>
    <p>Not all conditions are created equal. Averaging 50 on seaming pitches against quality attacks is a far greater achievement than averaging 50 on flat roads. We normalize for this by looking at the <strong>specific matches</strong> each player appeared in.</p>
    ${pitchDesc}
    <p>These factors are applied to BEI and BoEI <strong>before</strong> the rating conversion, so the final ratings reflect how impressive a player's performance was <em>relative to the difficulty of the conditions they faced</em>.</p>

    <h3>Allrounder Excellence Index (AEI)</h3>
    <div class="formula">${arRankFormula}</div>
    ${arDesc}

    <h3>Minimum Qualification</h3>
    <p>Players must have played at least <strong>${m.min_matches} matches</strong> to qualify.${CURRENT_FORMAT === 'ipl' ? '' : ' Only ICC Full Member nations are included in the rankings.'}</p>

    <h3>Career Charts</h3>
    <p>The per-player career charts show how a player's form evolved over time in match-window stints. These are for visualization only — the ranking formula uses career totals.</p>

    ${ratingDesc}
    `;
  } else {
    html = `
    <h2>${label} Methodology</h2>

    <h3>The Problem with Career Averages</h3>
    <p>A player who averages 50 over 20 ${label}s is <strong>not</strong> the same as someone who averages 50 over 180 ${label}s. The second player sustained that level for nine times longer — through form slumps, injuries, pitch conditions across decades, and the wear of 160 extra matches. Career averages treat them identically. Our index does not.</p>

    <h3>Batting Excellence Index (BEI)</h3>
    <div class="formula">BEI = avg<sup>0.7</sup> × RPI<sup>0.3</sup> × innings<sup>${longevityExp}</sup></div>
    <p>The batting quality metric uses a <strong>weighted geometric mean</strong> of the career average and runs per innings (RPI = runs ÷ innings). Career average (runs ÷ dismissals) rewards not-outs, while RPI measures raw per-innings production. The weighting (avg<sup>0.7</sup> × RPI<sup>0.3</sup>) applies a moderate not-out correction — it still gives substantial credit for not-outs (a genuine 150* deserves more than 150), but prevents players with high not-out rates from having inflated ratings relative to openers who get out nearly every innings. This exponent (0.3) is uniform across all formats. The <strong>innings<sup>${longevityExp}</sup></strong> exponent provides a meaningful but controlled longevity bonus.</p>

    <h3>Bowling Excellence Index (BoEI)</h3>
    <div class="formula">BoEI = (${m.bowl_k} / bowl_avg) × √(wpi / baseline_wpi) × (baseline_sr / sr)<sup>${m.sr_exp}</sup> × innings<sup>${longevityExp}</sup> × scale</div>
    <p>Bowling averages are "lower is better," so we flip them. The <strong>wickets per innings (wpi)</strong> factor captures volume — a strike bowler averaging 22 and taking 2.5 wickets per innings scores far higher than a part-timer averaging 22 but taking 1 per innings. We use wickets per <em>innings</em> rather than per match because it normalizes for matches where a bowler didn't get to bowl both innings (rain, declarations, one-sided games). The square root dampens the volume factor so quality still dominates.</p>
    <p>The <strong>strike rate factor</strong> (baseline_sr / sr)<sup>${m.sr_exp}</sup> gives a mild boost to bowlers who take wickets frequently. The baseline SR is ${m.baseline_sr} (mean across all qualifying bowlers). A bowler with SR 50 gets a ~${Math.round(((m.baseline_sr/50)**m.sr_exp - 1)*100)}% boost, while one at SR 80 is roughly neutral. The low exponent (${m.sr_exp}) keeps this gentle — bowling average remains the dominant quality signal, but strike bowlers like Ambrose and Waqar get appropriate recognition over accumulation-style bowlers.</p>
    <p>A data-driven scaling factor (×${m.boei_scale}) ensures that BEI and BoEI are on comparable scales. Bowlers must have at least <strong>${m.min_bowl_inns} bowling innings</strong> to qualify.</p>

    <h3>Pitch &amp; Era Normalization</h3>
    <p>Not all conditions are created equal. Averaging 50 on seaming pitches against quality attacks is a far greater achievement than averaging 50 on flat roads. We normalize for this by looking at the <strong>specific matches</strong> each player appeared in.</p>
    ${pitchDesc}
    <p>These factors are applied to BEI and BoEI <strong>before</strong> the rating conversion, so the final ratings reflect how impressive a player's performance was <em>relative to the difficulty of the conditions they faced</em>.</p>

    <h3>Allrounder Excellence Index (AEI)</h3>
    <div class="formula">${arRankFormula}</div>
    ${arDesc}

    <h3>Minimum Qualification</h3>
    <p>Players must have played at least <strong>${m.min_matches || 20} matches</strong> to qualify. Only ICC Full Member nations are included in the rankings.</p>

    <h3>Career Charts</h3>
    <p>The per-player career charts show 10-match stint breakdowns for visualization — they illustrate how a player's form evolved over time. These are for visualization only — the ranking formula uses career totals.</p>

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
  const α = m.rpi_alpha || 0.3;
  const longevity = m.longevity_exp || 0.3;
  const rBase = m.rating_base || 500;
  const rK = m.rating_k || 250;
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
    const longevityFactor = Math.pow(inns, longevity);

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
      const econSuffix = isLOI && player.match_rpo ? ` · Match econ ${player.match_rpo.toFixed(2)}` : '';
      bars += _barHTML('Conditions', `Match avg ${player.match_avg.toFixed(1)}${econSuffix}`, condPct, condLabel, condClass);
    }

    const beiMedian = m.bei_median;
    const beiStd = m.bei_std;
    const z = beiStd > 0 ? (player.BEI - beiMedian) / beiStd : 0;
    const sdLabel = z >= 0 ? `${z.toFixed(1)} standard deviations above` : `${Math.abs(z).toFixed(1)} standard deviations below`;

    const formulaParts = [];
    formulaParts.push(`avg<sup>0.7</sup> × rpi<sup>0.3</sup> = ${avg}^0.7 × ${rpi.toFixed(1)}^0.3 = ${qualityMetric.toFixed(2)}`);
    if (isLOI && sr) formulaParts.push(`× SR/100 = × ${(sr/100).toFixed(2)}`);
    formulaParts.push(`× innings<sup>0.3</sup> = × ${inns}^0.3 = × ${longevityFactor.toFixed(2)}`);
    if (pitchAdj !== 1) formulaParts.push(`× pitch adj = × ${pitchAdj.toFixed(2)}`);
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
    const pitchAdj = player.bowl_pitch_factor || 1;
    const bowlK = m.bowl_k || 1000;
    const longevityFactor = Math.pow(bowlInns, longevity);

    const bowlers = all.filter(p => p.bowl_inns > 0 && p.career_bowl_avg > 0);
    const allBowlAvg = bowlers.map(p => p.career_bowl_avg);
    const allBowlInns = bowlers.map(p => p.bowl_inns);

    const bowlAvgPct = _percentile(allBowlAvg.map(v => -v), -bowlAvg);
    const [bowlAvgTier, bowlAvgTierClass] = _tier(bowlAvgPct);
    const bowlInnsPct = _percentile(allBowlInns, bowlInns);
    const [bowlInnsTier, bowlInnsTierClass] = _tier(bowlInnsPct);

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

    bars += _barHTML('Longevity', `${bowlInns} innings`, bowlInnsPct, bowlInnsTier, bowlInnsTierClass);

    if (player.match_avg) {
      const allMatchAvg = all.filter(p => p.match_avg > 0).map(p => p.match_avg);
      const condPct = _percentile(allMatchAvg, player.match_avg);
      let condLabel, condClass;
      if (condPct >= 60)      { condLabel = 'Tough'; condClass = 'bd-tier-elite'; }
      else if (condPct >= 35) { condLabel = 'Medium'; condClass = 'bd-tier-good'; }
      else                    { condLabel = 'Easy'; condClass = 'bd-tier-avg'; }
      const econSuffix = isLOI && player.match_rpo ? ` · Match econ ${player.match_rpo.toFixed(2)}` : '';
      bars += _barHTML('Conditions', `Match avg ${player.match_avg.toFixed(1)}${econSuffix}`, condPct, condLabel, condClass);
    }

    const boeiMedian = m.boei_median;
    const boeiStd = m.boei_std;
    const z = boeiStd > 0 ? (player.BoEI - boeiMedian) / boeiStd : 0;
    const sdLabel = z >= 0 ? `${z.toFixed(1)} standard deviations above` : `${Math.abs(z).toFixed(1)} standard deviations below`;

    let formulaParts = [];
    if (isLOI) {
      const bowlSr = player.career_bowl_sr || (bowlAvg * 6 / (player.career_bowl_econ || 6));
      const econ = player.career_bowl_econ || 6;
      formulaParts.push(`${bowlK} / (SR × econ/6) = ${bowlK} / (${bowlSr.toFixed(1)} × ${(econ/6).toFixed(2)}) = ${(bowlK / (bowlSr * econ / 6)).toFixed(2)}`);
    } else {
      formulaParts.push(`${bowlK} / avg = ${bowlK} / ${bowlAvg.toFixed(1)} = ${(bowlK / bowlAvg).toFixed(2)}`);
      if (player.career_wpi != null) {
        const baseWpi = m.baseline_wpi || 1.46;
        formulaParts.push(`× √(wpi/baseline) = √(${player.career_wpi.toFixed(3)}/${baseWpi}) = ${Math.sqrt(player.career_wpi/baseWpi).toFixed(2)}`);
      }
      if (player.career_bowl_sr) {
        const baseSr = m.baseline_sr || 79.9;
        const srExp = m.sr_exp || 0.2;
        formulaParts.push(`× (${baseSr}/sr)^${srExp} = (${baseSr}/${player.career_bowl_sr})^${srExp} = ${Math.pow(baseSr/player.career_bowl_sr, srExp).toFixed(2)}`);
      }
    }
    formulaParts.push(`× innings<sup>0.3</sup> = × ${bowlInns}^0.3 = × ${longevityFactor.toFixed(2)}`);
    if (pitchAdj !== 1) formulaParts.push(`× pitch adj = × ${pitchAdj.toFixed(2)}`);
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
    </details>
  `;
}

function showPlayer(name, updateHash = true) {
  const player = DATA.all_players.find(p => p.name === name);
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
    const batF = player.bat_pitch_factor.toFixed(2);
    const bowlF = player.bowl_pitch_factor.toFixed(2);
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
    `${CROSS_FORMAT_DATA.all3.batting.length} players in all 3 formats \u00b7 ${CROSS_FORMAT_DATA.testOdi.batting.length} in Tests + ODIs`;

  document.getElementById('heading-allrounders').textContent = 'Cross-Format Allrounder GOATs';
  document.querySelector('#panel-allrounders .panel-desc').textContent =
    'The greatest allrounders across international formats, ranked by geometric mean of combined batting and bowling ratings. Must have combined batting \u2265 500 and bowling \u2265 500.';

  document.getElementById('heading-batting').textContent = 'Cross-Format Batting GOATs';
  document.querySelector('#panel-batting .panel-desc').textContent =
    'The greatest batsmen across international formats, ranked by the sum of format-specific batting ratings.';

  document.getElementById('heading-bowling').textContent = 'Cross-Format Bowling GOATs';
  document.querySelector('#panel-bowling .panel-desc').textContent =
    'The greatest bowlers across international formats, ranked by the sum of format-specific bowling ratings.';

  renderXFCategory('allrounders', 'ar_total', CROSS_FORMAT_DATA.all3.allrounders, CROSS_FORMAT_DATA.testOdi.allrounders, true);
  renderXFCategory('batting', 'bat_total', CROSS_FORMAT_DATA.all3.batting, CROSS_FORMAT_DATA.testOdi.batting, false);
  renderXFCategory('bowling', 'bowl_total', CROSS_FORMAT_DATA.all3.bowling, CROSS_FORMAT_DATA.testOdi.bowling, false);

  renderCrossFormatMethodology();
}

function renderXFCategory(category, ratingKey, all3Data, testOdiData, isAR) {
  const tableContainer = document.getElementById(`table-${category}`);
  const chartContainer = document.getElementById(`chart-${category}`);
  const prefix = category === 'batting' ? 'bat' : 'bowl';

  const all3Fmt = [
    { key: `${prefix}_tests`, label: 'Tests' },
    { key: `${prefix}_odis`, label: 'ODIs' },
    { key: `${prefix}_t20is`, label: 'T20Is' },
  ];
  const testOdiFmt = [
    { key: `${prefix}_tests`, label: 'Tests' },
    { key: `${prefix}_odis`, label: 'ODIs' },
  ];

  let tableHTML = `<h3 class="xf-section-title">All 3 Formats (Tests + ODIs + T20Is) <span class="xf-count">\u2014 ${all3Data.length} players</span></h3>`;
  tableHTML += renderXFRows(all3Data.slice(0, 25), ratingKey, isAR ? null : all3Fmt, isAR);
  tableHTML += `<h3 class="xf-section-title xf-section-gap">Test + ODI <span class="xf-count">\u2014 ${testOdiData.length} players</span></h3>`;
  tableHTML += renderXFRows(testOdiData.slice(0, 25), ratingKey, isAR ? null : testOdiFmt, isAR);
  tableContainer.innerHTML = tableHTML;

  const cid1 = `xf-chart-${category}-all3`;
  const cid2 = `xf-chart-${category}-testodi`;
  chartContainer.innerHTML = `
    <h3 class="xf-section-title">All 3 Formats (Tests + ODIs + T20Is)</h3>
    <div id="${cid1}"></div>
    <h3 class="xf-section-title xf-section-gap">Test + ODI</h3>
    <div id="${cid2}"></div>`;

  if (isAR) {
    renderXFArChart(cid1, all3Data);
    renderXFArChart(cid2, testOdiData);
  } else {
    renderXFStackedChart(cid1, all3Data, prefix, true);
    renderXFStackedChart(cid2, testOdiData, prefix, false);
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

function renderXFStackedChart(divId, players, prefix, hasT20) {
  const mobile = isMobile();
  const n = mobile ? 15 : 25;
  const top = players.slice(0, n).reverse();
  const labels = top.map(p => mobile ? p.name.split(' ').pop() : `${getFlag(p.country)} ${p.name}`);

  const traces = [
    {
      y: labels, x: top.map(p => p[prefix + '_tests']),
      type: 'bar', orientation: 'h', name: 'Tests',
      marker: { color: XF_COLORS.tests },
      text: top.map(p => p[prefix + '_tests'] > 0 ? p[prefix + '_tests'] : ''),
      textposition: 'inside', textfont: { color: '#fff', size: mobile ? 9 : 11 },
      hovertemplate: '%{y}<br>Tests: %{x}<extra></extra>',
    },
    {
      y: labels, x: top.map(p => p[prefix + '_odis']),
      type: 'bar', orientation: 'h', name: 'ODIs',
      marker: { color: XF_COLORS.odis },
      text: top.map(p => p[prefix + '_odis'] > 0 ? p[prefix + '_odis'] : ''),
      textposition: 'inside', textfont: { color: '#fff', size: mobile ? 9 : 11 },
      hovertemplate: '%{y}<br>ODIs: %{x}<extra></extra>',
    },
  ];

  if (hasT20) {
    traces.push({
      y: labels, x: top.map(p => p[prefix + '_t20is']),
      type: 'bar', orientation: 'h', name: 'T20Is',
      marker: { color: XF_COLORS.t20is },
      text: top.map(p => p[prefix + '_t20is'] > 0 ? p[prefix + '_t20is'] : ''),
      textposition: 'inside', textfont: { color: '#fff', size: mobile ? 9 : 11 },
      hovertemplate: '%{y}<br>T20Is: %{x}<extra></extra>',
    });
  }

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
  el.innerHTML = `
    <h2>Cross-Format Methodology</h2>

    <h3>Concept</h3>
    <p>The Cross-Format GOAT rankings identify the greatest cricketers across multiple international formats. Instead of looking at one format in isolation, we combine a player's per-format ratings to find those who excelled across the board.</p>

    <h3>Qualification</h3>
    <p>For <strong>"All 3 Formats"</strong>, a player must appear in the individual rankings for Tests, ODIs, <em>and</em> T20Is \u2014 meaning they met the minimum match and innings thresholds in each format independently. Players like Bradman, who only played Tests, are excluded.</p>
    <p>For <strong>"Test + ODI"</strong>, a player must appear in both Test and ODI rankings. This captures the great players from the pre-T20 era.</p>

    <h3>Batting GOAT</h3>
    <div class="formula">Combined Batting Rating = Test bat rating + ODI bat rating + T20I bat rating</div>
    <p>Each format's batting rating is computed independently using its own methodology \u2014 stint-based integral for Tests, career formula (avg \u00d7 SR/100 \u00d7 innings<sup>0.2</sup>) for LOIs \u2014 with pitch difficulty normalization. The sum rewards players who were elite batsmen across all formats they played. A higher total means consistent excellence across more formats.</p>

    <h3>Bowling GOAT</h3>
    <div class="formula">Combined Bowling Rating = Test bowl rating + ODI bowl rating + T20I bowl rating</div>
    <p>Same principle as batting. Bowlers who adapted their skills to the different demands of each format \u2014 the patience of Tests, the containment of ODIs, and the death bowling of T20s \u2014 accumulate a higher combined rating.</p>

    <h3>Allrounder GOAT</h3>
    <div class="formula">Combined AR Rating = \u221a(Combined Bat Rating \u00d7 Combined Bowl Rating)</div>
    <p>The geometric mean of combined batting and bowling ratings rewards players who contributed significantly with <strong>both</strong> bat and ball across formats. A player must have a combined batting rating of at least <strong>${XF_MIN_AR}</strong> and a combined bowling rating of at least <strong>${XF_MIN_AR}</strong> to qualify. This filters out pure batsmen and pure bowlers.</p>

    <h3>Why Sum?</h3>
    <p>We use a simple sum rather than an average because it naturally rewards versatility across more formats. A player who excels in 3 formats has demonstrated the ability to adapt across very different game situations \u2014 the urgency of T20s, the tactical depth of ODIs, and the mental and physical challenge of Tests. Being great in more formats means a higher combined rating.</p>

    <h3>Why Not Average?</h3>
    <p>An average would rank a player with 950 in Tests + 950 in ODIs + 200 in T20Is (avg: 700) below one with 750 across all three (avg: 750). But the first player achieved far more sustained excellence in two formats than the second. The sum captures this: total greatness across formats, not average greatness.</p>
  `;
}

// ─── Tab Navigation ─────────────────────────────────────────────────────────

function switchTab(tabId, updateHash = true) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById(`panel-${tabId}`).classList.add('active');

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

// ─── Init ───────────────────────────────────────────────────────────────────

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
