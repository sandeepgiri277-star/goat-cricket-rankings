/* ─── GOAT Cricket Rankings — Frontend ──────────────────────────────────── */

const ALL_DATA = {};
let DATA = null;
let CURRENT_FORMAT = 'tests';

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
};

const COLORS = {
  bat: '#636EFA',
  bowl: '#00CC96',
  aei: '#EF553B',
  gold: '#FFD700',
  silver: '#C0C0C0',
  bronze: '#CD7F32',
};

const plotlyConfig = { responsive: true, displayModeBar: false };

function isMobile() { return window.innerWidth <= 700; }

// Country code → flag emoji
const FLAGS = {
  AUS: '\u{1F1E6}\u{1F1FA}', ENG: '\u{1F1EC}\u{1F1E7}', IND: '\u{1F1EE}\u{1F1F3}',
  PAK: '\u{1F1F5}\u{1F1F0}', SA: '\u{1F1FF}\u{1F1E6}', WI: '\u{1F3DD}\uFE0F',
  NZ: '\u{1F1F3}\u{1F1FF}', SL: '\u{1F1F1}\u{1F1F0}', BAN: '\u{1F1E7}\u{1F1E9}',
  ZIM: '\u{1F1FF}\u{1F1FC}', ICC: '\u{1F3CF}',
};

function getFlag(country) {
  if (!country) return '';
  const skip = new Set(['ICC', 'Asia', 'Afr']);
  const parts = country.split('/');
  const real = parts.find(c => !skip.has(c)) || parts[0];
  return FLAGS[real] || '\u{1F3CF}';
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
  const data = await loadFormatData(format);
  if (!data) {
    alert(`${FORMAT_LABELS[format]} rankings data not yet available.`);
    return;
  }
  CURRENT_FORMAT = format;
  DATA = data;

  document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.format-btn[data-format="${format}"]`).classList.add('active');

  buildNameIndex();
  updateFormatLabels();
  renderAll();

  document.getElementById('player-card').classList.add('hidden');
  document.getElementById('player-search').value = '';

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

  const formatPrefixes = Object.keys(FORMAT_FILES);
  for (const f of formatPrefixes) {
    if (hash === f || hash.startsWith(f + '/')) {
      format = f;
      rest = hash.slice(f.length + 1) || 'allrounders';
      break;
    }
  }

  if (format !== CURRENT_FORMAT) {
    const data = await loadFormatData(format);
    if (data) {
      CURRENT_FORMAT = format;
      DATA = data;
      document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
      const btn = document.querySelector(`.format-btn[data-format="${format}"]`);
      if (btn) btn.classList.add('active');
      buildNameIndex();
      updateFormatLabels();
      renderAll();
    }
  }

  if (rest.startsWith('player/')) {
    const name = rest.slice(7);
    switchTab('player-lookup', false);
    document.getElementById('player-search').value = name;
    setTimeout(() => showPlayer(name, false), 120);
  } else {
    const validTabs = ['allrounders', 'batting', 'bowling', 'player-lookup', 'methodology'];
    if (validTabs.includes(rest)) {
      switchTab(rest, false);
    }
  }
}

function updateFormatLabels() {
  const label = FORMAT_LABELS[CURRENT_FORMAT] || 'Test';
  const isLOI = CURRENT_FORMAT !== 'tests';
  const stintDesc = isLOI ? `${DATA.metadata.stint_innings}-innings stints` : `${DATA.metadata.stint_size}-match stints`;
  document.getElementById('heading-allrounders').textContent = `Top 100 ${label} Allrounders`;
  document.getElementById('heading-batting').textContent = `Top 100 ${label} Batters`;
  document.getElementById('heading-bowling').textContent = `Top 100 ${label} Bowlers`;
  document.querySelector('#panel-batting .panel-desc').textContent = `The greatest batsmen in ${label} cricket history, ranked by sustained batting excellence across ${stintDesc}. Click any player to explore their career.`;
  document.querySelector('#panel-bowling .panel-desc').textContent = `The greatest bowlers in ${label} cricket history, ranked by sustained bowling excellence across ${stintDesc}. Click any player to explore their career.`;
}

function renderAll() {
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

function renderAllrounderTable() {
  const container = document.getElementById('table-allrounders');
  container.innerHTML = DATA.allrounder_top25.map((p, i) => `
    <div class="lb-row ${medalClass(i)}" data-player="${p.name}">
      <div class="lb-rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="lb-flag">${getFlag(p.country)}</div>
      <div class="lb-info">
        <div class="lb-name">${p.name}</div>
        <div class="lb-country">${p.country} · ${p.matches} matches</div>
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
        <div class="lb-country">${p.country} · ${p.matches} matches</div>
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
        <div class="lb-country">${p.country} · ${p.matches} matches</div>
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
  const el = document.getElementById('methodology-content');
  if (!el) return;
  const m = DATA.metadata;
  const isLOI = CURRENT_FORMAT !== 'tests';
  const label = FORMAT_LABELS[CURRENT_FORMAT] || 'Test';
  const alpha = m.alpha;

  const stintDesc = isLOI
    ? `We divide every career into <strong>${m.stint_innings}-innings windows</strong> — separately for batting and bowling. Because ODIs can include matches where a player doesn't bat or bowl, we track <em>innings played</em> rather than matches. If the final window is shorter than ${m.stint_innings} innings, it merges into the previous one.`
    : `We divide every career into <strong>${m.stint_size}-match windows</strong> and compute batting and bowling averages independently for each window. If the final leftover is shorter than ${m.stint_size} matches, it merges into the previous window (e.g., 71 matches → stints of 10, 10, 10, 10, 10, 10, 11). This gives us a picture of how a player performed at each stage of their career — not just one blended number.`;

  const minQualDesc = isLOI
    ? `Players must have played at least <strong>${m.min_matches} matches</strong> to qualify. Each stint requires ≥ <strong>${m.stint_innings} batting innings</strong> (batting) or ≥ <strong>${m.stint_innings} bowling innings</strong> (bowling) to count. Only ICC Full Member nations are included in the rankings.`
    : `Each stint requires ≥ <strong>${m.min_stint_bat_inn} batting innings</strong> (batting) or ≥ <strong>${m.min_stint_bowl_inn} bowling innings</strong> (bowling) to count. This filters out part-time players and prevents small samples from producing misleading averages.`;

  const batFormula = isLOI
    ? `bat_metric = batting_avg × (strike_rate / 100)`
    : `bat_metric = batting_avg`;

  const batFormulaDesc = isLOI
    ? `In limited-overs cricket, <strong>how fast</strong> you score matters as much as <strong>how many</strong> you score. A player averaging 40 at a strike rate of 95 is far more valuable than one averaging 40 at 65. The batting metric captures both dimensions.`
    : `The sum of each stint's batting average weighted by matches, divided by a career-length adjustment. Averaging 55 across fifteen 10-match stints produces a far higher BEI than averaging 55 across three stints.`;

  const bowlFormula = isLOI
    ? `bowl_score = (${m.bowl_k} / (bowl_avg × economy / 6)) × √(wpm / baseline_wpm)`
    : `bowl_score = (${m.bowl_k} / bowl_avg) × √(wpm / baseline_wpm)`;

  const bowlFormulaDesc = isLOI
    ? `In limited-overs cricket, a bowler's <strong>economy rate</strong> matters alongside their average. Conceding 4 runs per over while taking wickets is far more valuable than conceding 6. The metric penalizes expensive bowlers even if they take wickets frequently.`
    : `This captures both <strong>quality</strong> (average) and <strong>volume</strong> (wickets per match). A bowler averaging 22 and taking 5 wickets per match scores far higher than one averaging 22 but taking only 1 per match. The square root dampens the volume factor so quality still dominates.`;

  const beiFormula = isLOI
    ? `BEI = (∑ bat_metric × stint_matches) / M<sup>${alpha}</sup>`
    : `BEI = (∑ stint_bat_avg × stint_matches) / M<sup>${alpha}</sup>`;

  const alphaDesc = isLOI
    ? `At α = ${alpha}, sustaining ${label} excellence over a long career is rewarded, but quality per match still matters most.`
    : `At α = ${alpha}, sustaining excellence over a long career is clearly rewarded, but quality per match still matters most.`;

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

  let html = `
    <h2>${label} Methodology</h2>

    <h3>The Problem with Career Averages</h3>
    <p>A player who averages 50 over 20 ${label}s is <strong>not</strong> the same as someone who averages 50 over 180 ${label}s. The second player sustained that level for nine times longer — through form slumps, injuries, pitch conditions across decades, and the wear of 160 extra matches. Career averages treat them identically. Our index does not.</p>

    <h3>Stint-Based Approach</h3>
    <p>${stintDesc}</p>

    <h3>Minimum Qualification</h3>
    <p>${minQualDesc}</p>

    <h3>How the Index Works</h3>
    <p>Think of it as the <strong>area under the curve</strong> of a player's stint scores plotted over their career. A player who bats well for 15 stints accumulates more area than someone equally skilled over 5 stints. This integral naturally rewards both quality <em>and</em> longevity.</p>

    <h3>Batting Excellence Index (BEI)</h3>
    <div class="formula">${beiFormula}</div>
    <div class="formula">${batFormula}</div>
    <p>${batFormulaDesc}</p>

    <h3>Bowling Score Transformation</h3>
    <p>Bowling averages are "lower is better," so we flip them and factor in <strong>wickets per match</strong>${isLOI ? ' and <strong>economy rate</strong>' : ''}:</p>
    <div class="formula">${bowlFormula}</div>
    <p>${bowlFormulaDesc}</p>

    <h3>Bowling Excellence Index (BoEI)</h3>
    <div class="formula">
      BoEI = (∑ bowl_score × stint_matches) × scale / M<sup>${alpha}</sup>
    </div>
    <p>Same integral concept as BEI, but for bowling scores. A data-driven scaling factor (×${m.boei_scale}) ensures that the average bowling stint contributes equally to the average batting stint, so the two indices are comparable.</p>

    <h3>Why M<sup>${alpha}</sup>?</h3>
    <p>The raw integral grows with career length, so we divide by M<sup>α</sup> (where α = ${alpha}) to control <em>how much</em> longevity matters. At α = 1.0, two players with the same per-stint quality would rate equally regardless of career length. At α = 0.5, the longer career would dominate. ${alphaDesc}</p>

    ${DATA.alpha_comparison ? `
    <div class="alpha-section">
      <h4>Alpha Sensitivity</h4>
      <p>How do the top 15 rankings change as α varies from 0.5 to 1.0?</p>
      <div class="alpha-tabs" id="alpha-tabs">
        <button class="alpha-tab active" data-category="allrounder">Allrounders</button>
        <button class="alpha-tab" data-category="batting">Batting</button>
        <button class="alpha-tab" data-category="bowling">Bowling</button>
      </div>
      <div class="table-wrap">
        <table class="alpha-table" id="alpha-table">
          <thead id="alpha-thead"></thead>
          <tbody id="alpha-tbody"></tbody>
        </table>
      </div>
    </div>` : ''}

    <h3>Allrounder Excellence Index (AEI)</h3>
    <div class="formula">${arRankFormula}</div>
    ${arDesc}

    ${DATA.distributions ? `
    <h3>Distribution Overview</h3>
    <p>The density curves below show where all qualifying ${label} players fall across BEI, BoEI, and AEI.</p>
    <div class="chart-container" id="chart-kde"></div>` : ''}

    <h3>Pitch Difficulty Normalization</h3>
    <p>Not all conditions are created equal. Averaging 50 on seaming pitches against quality attacks is a far greater achievement than averaging 50 on flat roads. We normalize for this by looking at the <strong>specific matches</strong> each player appeared in.</p>
    ${pitchDesc}
    <p>These factors are applied to BEI and BoEI <strong>before</strong> the rating conversion, so the final ratings reflect how impressive a player's performance was <em>relative to the difficulty of the conditions they faced</em>.</p>

    <h3>Rating Scale (0–1000)</h3>
    <p>Pitch-adjusted indices are converted to an ICC-style rating using z-scores with square-root compression:</p>
    <div class="formula">
      Rating = ${m.rating_base} + ${m.rating_k} × √z &nbsp;&nbsp; where z = (value − μ) / σ
    </div>
    <p>The square root compresses extreme outliers. Ratings above <strong>900</strong> represent all-time elite players, <strong>800+</strong> is great, and <strong>700+</strong> is very good.</p>
  `;

  el.innerHTML = html;

  if (DATA.distributions) renderKDE();
  if (DATA.alpha_comparison) {
    renderAlphaTable('allrounder');
    setupAlphaTabs();
  }
}

function setupAlphaTabs() {
  document.querySelectorAll('.alpha-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.alpha-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderAlphaTable(tab.dataset.category);
    });
  });
}

function renderKDE() {
  const traces = [];
  const items = [
    { key: 'BEI', color: COLORS.bat, label: 'Batting (BEI)' },
    { key: 'BoEI', color: COLORS.bowl, label: 'Bowling (BoEI)' },
    { key: 'AEI', color: COLORS.aei, label: 'Combined (AEI)' },
  ];

  for (const item of items) {
    const kde = DATA.distributions[item.key].kde;
    traces.push({
      x: kde.x, y: kde.y, type: 'scatter', mode: 'lines',
      name: item.label, line: { color: item.color, width: 2.5 },
      fill: 'tozeroy', opacity: 0.3,
    });

    const p90 = DATA.distributions[item.key].percentiles.p90;
    traces.push({
      x: [p90, p90], y: [0, Math.max(...kde.y) * 0.7],
      type: 'scatter', mode: 'lines',
      line: { color: item.color, width: 1, dash: 'dot' },
      showlegend: false,
      hovertemplate: `${item.key} 90th percentile: ${p90}<extra></extra>`,
    });
  }

  const mobile = isMobile();
  const layout = plotlyLayout({
    height: mobile ? 280 : 350,
    xaxis: { title: 'Index Value', tickfont: { size: mobile ? 9 : 12 } },
    yaxis: { title: 'Density', showticklabels: false },
    legend: { orientation: 'h', y: 1.1, x: 0.5, xanchor: 'center', font: { size: mobile ? 10 : 12 } },
    margin: { l: mobile ? 30 : 50, r: mobile ? 10 : 30, t: 20, b: mobile ? 40 : 50 },
  });

  Plotly.newPlot('chart-kde', traces, layout, plotlyConfig);
}

// ─── Alpha Sensitivity Table ────────────────────────────────────────────────

function renderAlphaTable(category) {
  const alphas = Object.keys(DATA.alpha_comparison);
  const thead = document.getElementById('alpha-thead');
  const tbody = document.getElementById('alpha-tbody');
  if (!thead || !tbody) return;

  const currentAlpha = String(DATA.metadata.alpha);
  const metricKey = category === 'batting' ? 'BEI' : category === 'bowling' ? 'BoEI' : 'AEI';
  const dataSets = {};
  for (const a of alphas) {
    dataSets[a] = DATA.alpha_comparison[a][category];
  }

  thead.innerHTML = `<tr><th></th>${alphas.map(a =>
    `<th class="${a === currentAlpha ? 'alpha-current' : ''}">\u03b1=${a}</th>`
  ).join('')}</tr>`;

  let rows = '';
  for (let rank = 0; rank < 15; rank++) {
    rows += `<tr><td class="alpha-rank">${rank + 1}</td>`;
    for (const a of alphas) {
      const list = dataSets[a];
      if (rank < list.length) {
        const p = list[rank];
        const name = p.name.length > 16 ? p.name.slice(0, 15) + '\u2026' : p.name;
        const rating = p[metricKey + '_rating'] || Math.round(p[metricKey]);
        rows += `<td class="${a === currentAlpha ? 'alpha-current' : ''}">${name} <span style="color:var(--text-muted)">${rating}</span></td>`;
      } else {
        rows += '<td></td>';
      }
    }
    rows += '</tr>';
  }
  tbody.innerHTML = rows;
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
          <span class="sr-meta">${p.country} · ${p.matches} matches</span>
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

function showPlayer(name, updateHash = true) {
  const player = DATA.all_players.find(p => p.name === name);
  if (!player) return;

  if (updateHash) {
    history.pushState(null, '', `#${CURRENT_FORMAT}/player/${encodeURIComponent(name)}`);
  }

  const card = document.getElementById('player-card');
  card.classList.remove('hidden');

  let stats = '';
  if (player.bat_rating > 0) {
    const rankLabel = player.bat_rank ? ` (#${player.bat_rank})` : '';
    stats += `<div class="ph-stat"><div class="label">Bat Rating</div><div class="value bei">${player.bat_rating}${rankLabel}</div></div>`;
  }
  if (player.bowl_rating > 0) {
    const rankLabel = player.bowl_rank ? ` (#${player.bowl_rank})` : '';
    stats += `<div class="ph-stat"><div class="label">Bowl Rating</div><div class="value boei">${player.bowl_rating}${rankLabel}</div></div>`;
  }
  if (player.ar_rank) {
    stats += `<div class="ph-stat"><div class="label">Allrounder</div><div class="value">${player.ar_rating} (#${player.ar_rank})</div></div>`;
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
      <div class="ph-country">${player.country} · ${player.matches} matches</div>
      ${pitchInfo}
    </div>
    <div class="ph-stats">${stats}</div>
  `;

  renderPlayerCareer(player);
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
  if (hasBat) rows.push('bat');
  if (hasBowl) rows.push('bowl');

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
    legend: isLOI ? { orientation: 'h', y: 1.05, x: 0.5, xanchor: 'center', font: { size: 11 } } : undefined,
    margin: { l: mobile ? 40 : 60, r: isLOI ? (mobile ? 50 : 70) : (mobile ? 15 : 30), t: mobile ? 10 : 10, b: mobile ? 30 : 40 },
    annotations: [],
  };

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
      layout[yName].title = '';
      layout[yName].range = [0, batMax * 1.3];
      const windowDesc = isLOI ? `${DATA.metadata.stint_innings}-innings window` : `${DATA.metadata.stint_size}-match window`;
      const minDesc = isLOI ? `${DATA.metadata.stint_innings} innings` : `10 batting innings`;
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
          title: '',
          tickfont: { color: srColor, size: 10 },
          range: [0, srMax * 1.3], showgrid: false,
        };
      }
    } else if (r === 'bowl') {
      layout[yName].title = '';
      layout[yName].range = [0, bowlMax * 1.3];
      const bWindowDesc = isLOI ? `${DATA.metadata.stint_innings}-innings window` : `${DATA.metadata.stint_size}-match window`;
      const bMinDesc = isLOI ? `${DATA.metadata.stint_innings} innings` : `10 bowling innings`;
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
          title: '',
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
