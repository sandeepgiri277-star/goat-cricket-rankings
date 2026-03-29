/* ─── GOAT Cricket Rankings — Frontend ──────────────────────────────────── */

let DATA = null;

const COLORS = {
  bat: '#636EFA',
  bowl: '#00CC96',
  aei: '#EF553B',
  gold: '#FFD700',
  silver: '#C0C0C0',
  bronze: '#CD7F32',
};

const plotlyConfig = { responsive: true, displayModeBar: false };

// Country code → flag emoji
const FLAGS = {
  AUS: '\u{1F1E6}\u{1F1FA}', ENG: '\u{1F1EC}\u{1F1E7}', IND: '\u{1F1EE}\u{1F1F3}',
  PAK: '\u{1F1F5}\u{1F1F0}', SA: '\u{1F1FF}\u{1F1E6}', WI: '\u{1F3DD}\uFE0F',
  NZ: '\u{1F1F3}\u{1F1FF}', SL: '\u{1F1F1}\u{1F1F0}', BAN: '\u{1F1E7}\u{1F1E9}',
  ZIM: '\u{1F1FF}\u{1F1FC}', ICC: '\u{1F3CF}',
};

function getFlag(country) {
  if (!country) return '';
  const primary = country.split('/').pop();
  return FLAGS[primary] || FLAGS[country.split('/')[0]] || '\u{1F3CF}';
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

async function loadData() {
  try {
    const resp = await fetch('rankings.json');
    DATA = await resp.json();
    buildNameIndex();
    renderAll();
    document.body.classList.add('loaded');
  } catch (e) {
    document.querySelector('.content').innerHTML =
      '<p style="text-align:center;padding:3rem;color:var(--accent3)">Failed to load rankings data. Make sure rankings.json is available.</p>';
  }
}

function renderAll() {
  renderMeta();
  renderAllrounderChart();
  renderAllrounderTable();
  renderBattingChart();
  renderBattingTable();
  renderBowlingChart();
  renderBowlingTable();
  renderKDE();
  renderAlphaTable('allrounder');
  document.getElementById('boei-scale-display').textContent = `\u00d7${DATA.metadata.boei_scale}`;
}

function renderMeta() {
  const d = new Date(DATA.metadata.last_updated);
  document.getElementById('last-updated').textContent = `Last updated: ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  document.getElementById('player-count').textContent = `${DATA.metadata.total_players}`;
}

// ─── Allrounder Chart ───────────────────────────────────────────────────────

function renderAllrounderChart() {
  const players = [...DATA.allrounder_top25].slice(0, 25).reverse();
  const labels = players.map(p => `${getFlag(p.country)} ${p.name}`);

  const traces = [{
    y: labels, x: players.map(p => p.ar_rating), type: 'bar', orientation: 'h',
    marker: { color: players.map(p => p.ar_rating >= 1000 ? COLORS.aei : COLORS.bat) },
    text: players.map(p => p.ar_rating), textposition: 'inside',
    textfont: { color: '#fff', size: 12, weight: 700 },
    hovertemplate: '%{y}<br>Rating: %{x}<br>Bat: %{customdata[0]} · Bowl: %{customdata[1]}<extra></extra>',
    customdata: players.map(p => [p.bat_rating, p.bowl_rating]),
  }];

  const layout = plotlyLayout({
    height: Math.max(550, players.length * 30 + 80),
    margin: { l: 220, r: 60, t: 10, b: 30 },
    xaxis: { title: 'Rating' },
    showlegend: false,
  });

  Plotly.newPlot('chart-allrounders', traces, layout, plotlyConfig);
}

// ─── Batting Chart ──────────────────────────────────────────────────────────

function renderBattingChart() {
  const players = [...DATA.batting_top25].slice(0, 25).reverse();
  const labels = players.map(p => `${getFlag(p.country)} ${p.name}`);

  const traces = [{
    y: labels, x: players.map(p => p.bat_rating), type: 'bar', orientation: 'h',
    marker: { color: players.map(p => p.bat_rating >= 1000 ? COLORS.aei : COLORS.bat) },
    text: players.map(p => p.bat_rating), textposition: 'inside',
    textfont: { color: '#fff', size: 12, weight: 700 },
    hovertemplate: '%{y}<br>Rating: %{x}<br>%{customdata} matches<extra></extra>',
    customdata: players.map(p => p.matches),
  }];

  const layout = plotlyLayout({
    height: Math.max(550, players.length * 30 + 80),
    margin: { l: 220, r: 60, t: 10, b: 30 },
    xaxis: { title: 'Rating' },
    showlegend: false,
  });

  Plotly.newPlot('chart-batting', traces, layout, plotlyConfig);
}

// ─── Bowling Chart ──────────────────────────────────────────────────────────

function renderBowlingChart() {
  const players = [...DATA.bowling_top25].slice(0, 25).reverse();
  const labels = players.map(p => `${getFlag(p.country)} ${p.name}`);

  const traces = [{
    y: labels, x: players.map(p => p.bowl_rating), type: 'bar', orientation: 'h',
    marker: { color: players.map(p => p.bowl_rating >= 1000 ? COLORS.aei : COLORS.bowl) },
    text: players.map(p => p.bowl_rating), textposition: 'inside',
    textfont: { color: '#fff', size: 12, weight: 700 },
    hovertemplate: '%{y}<br>Rating: %{x}<br>%{customdata} matches<extra></extra>',
    customdata: players.map(p => p.matches),
  }];

  const layout = plotlyLayout({
    height: Math.max(550, players.length * 30 + 80),
    margin: { l: 220, r: 60, t: 10, b: 30 },
    xaxis: { title: 'Rating' },
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

  const layout = plotlyLayout({
    height: 350,
    xaxis: { title: 'Index Value' },
    yaxis: { title: 'Density', showticklabels: false },
    legend: { orientation: 'h', y: 1.1, x: 0.5, xanchor: 'center' },
    margin: { t: 20, b: 50 },
  });

  Plotly.newPlot('chart-kde', traces, layout, plotlyConfig);
}

// ─── Alpha Sensitivity Table ────────────────────────────────────────────────

function renderAlphaTable(category) {
  const alphas = Object.keys(DATA.alpha_comparison);
  const thead = document.getElementById('alpha-thead');
  const tbody = document.getElementById('alpha-tbody');

  const metricKey = category === 'batting' ? 'BEI' : category === 'bowling' ? 'BoEI' : 'AEI';
  const dataSets = {};
  for (const a of alphas) {
    dataSets[a] = DATA.alpha_comparison[a][category];
  }

  thead.innerHTML = `<tr><th></th>${alphas.map(a =>
    `<th class="${a === '0.7' ? 'alpha-current' : ''}">\u03b1=${a}</th>`
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
        rows += `<td class="${a === '0.7' ? 'alpha-current' : ''}">${name} <span style="color:var(--text-muted)">${rating}</span></td>`;
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

function showPlayer(name) {
  const player = DATA.all_players.find(p => p.name === name);
  if (!player) return;

  const card = document.getElementById('player-card');
  card.classList.remove('hidden');

  document.getElementById('player-header').innerHTML = `
    <div>
      <div class="ph-name">${getFlag(player.country)} ${player.name}</div>
      <div class="ph-country">${player.country} · ${player.matches} matches</div>
    </div>
    <div class="ph-stats">
      ${player.bat_rating > 0 ? `<div class="ph-stat"><div class="label">Bat Rating</div><div class="value bei">${player.bat_rating}</div></div>` : ''}
      ${player.bowl_rating > 0 ? `<div class="ph-stat"><div class="label">Bowl Rating</div><div class="value boei">${player.bowl_rating}</div></div>` : ''}
    </div>
  `;

  renderPlayerCareer(player);
}

function renderPlayerCareer(player) {
  const stints = player.stints;
  const labels = stints.map(s => s.label);
  const batVals = stints.map(s => s.bat_avg);
  const bowlVals = stints.map(s => s.bowl_avg);

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

  // Build axis assignments dynamically
  let axisIdx = 0;
  const axisMap = {};
  for (const r of rows) {
    axisIdx++;
    axisMap[r] = axisIdx;
  }

  function xKey(r) { return axisMap[r] === 1 ? 'x' : `x${axisMap[r]}`; }
  function yKey(r) { return axisMap[r] === 1 ? 'y' : `y${axisMap[r]}`; }

  if (hasBat) {
    traces.push({
      x: labels, y: batVals, type: 'bar', name: 'Batting Avg',
      marker: { color: batVals.map(v => v != null ? COLORS.bat : '#555') },
      opacity: 0.4, text: batVals.map(v => v != null ? v.toFixed(1) : ''),
      textposition: 'outside', cliponaxis: false, showlegend: false,
      hovertemplate: '%{x}<br>Batting Avg: %{y:.1f}<extra></extra>',
      xaxis: xKey('bat'), yaxis: yKey('bat'),
    });
    const valid = batVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
    if (valid.length >= 2) {
      traces.push({
        x: valid.map(([i]) => labels[i]), y: valid.map(([, v]) => v),
        type: 'scatter', mode: 'lines',
        line: { color: COLORS.bat, width: 3, shape: 'spline' }, showlegend: false,
        hovertemplate: 'Batting Avg: %{y:.1f}<extra></extra>',
        xaxis: xKey('bat'), yaxis: yKey('bat'),
      });
    }
  }

  if (hasBowl) {
    traces.push({
      x: labels, y: bowlVals, type: 'bar', name: 'Bowling Avg',
      marker: { color: bowlVals.map(v => v != null ? COLORS.bowl : '#555') },
      opacity: 0.4, text: bowlVals.map(v => v != null ? v.toFixed(1) : ''),
      textposition: 'outside', cliponaxis: false, showlegend: false,
      hovertemplate: '%{x}<br>Bowling Avg: %{y:.1f}<extra></extra>',
      xaxis: xKey('bowl'), yaxis: yKey('bowl'),
    });
    const valid = bowlVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
    if (valid.length >= 2) {
      traces.push({
        x: valid.map(([i]) => labels[i]), y: valid.map(([, v]) => v),
        type: 'scatter', mode: 'lines',
        line: { color: COLORS.bowl, width: 3, shape: 'spline' }, showlegend: false,
        hovertemplate: 'Bowling Avg: %{y:.1f}<extra></extra>',
        xaxis: xKey('bowl'), yaxis: yKey('bowl'),
      });
    }
  }

  const totalRows = rows.length;
  const gap = 0.14;

  const domains = [];
  let cursor = 1;
  for (let ri = 0; ri < totalRows; ri++) {
    const frac = totalRows === 2 ? 0.40 : 0.90;
    const top = cursor;
    const bottom = cursor - frac;
    domains.push([Math.max(0, bottom), top]);
    cursor = bottom - gap;
  }

  const batMax = hasBat ? Math.max(...batVals.filter(v => v != null), 10) : 10;
  const bowlMax = hasBowl ? Math.max(...bowlVals.filter(v => v != null), 10) : 10;

  const layout = {
    ...plotlyLayout(),
    height: totalRows === 1 ? 380 : 700,
    showlegend: false,
    margin: { l: 60, r: 30, t: 60, b: 40 },
    annotations: [],
  };

  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const n = ri + 1;
    const xName = n === 1 ? 'xaxis' : `xaxis${n}`;
    const yName = n === 1 ? 'yaxis' : `yaxis${n}`;

    layout[xName] = { gridcolor: gc, domain: [0, 1], anchor: n === 1 ? 'y' : `y${n}` };
    layout[yName] = { gridcolor: gc, domain: domains[ri], anchor: n === 1 ? 'x' : `x${n}` };

    const mutedColor = isDark ? '#8b8fa3' : '#6b7085';
    const titleY = domains[ri][1] + 0.055;
    const subtitleY = domains[ri][1] + 0.025;

    if (r === 'bat') {
      layout[yName].title = '';
      layout[yName].range = [0, batMax * 1.3];
      layout.annotations.push(
        { text: 'Batting Average per Stint', xref: 'paper', yref: 'paper', x: 0.5, y: titleY, showarrow: false, font: { size: 13, color: textColor } },
        { text: 'Average for each 10-match window (min. 10 batting innings to qualify)', xref: 'paper', yref: 'paper', x: 0.5, y: subtitleY, showarrow: false, font: { size: 10, color: mutedColor } },
      );
    } else if (r === 'bowl') {
      layout[yName].title = '';
      layout[yName].range = [0, bowlMax * 1.3];
      layout.annotations.push(
        { text: 'Bowling Average per Stint', xref: 'paper', yref: 'paper', x: 0.5, y: titleY, showarrow: false, font: { size: 13, color: textColor } },
        { text: 'Average for each 10-match window (min. 10 bowling innings to qualify) \u2014 lower is better', xref: 'paper', yref: 'paper', x: 0.5, y: subtitleY, showarrow: false, font: { size: 10, color: mutedColor } },
      );
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

function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById(`panel-${tabId}`).classList.add('active');

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

  document.querySelectorAll('.alpha-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.alpha-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderAlphaTable(tab.dataset.category);
    });
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

document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupTabs();
  setupSearch();
  loadData();
});
