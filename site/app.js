/* ─── GOAT Cricket Rankings — Frontend ──────────────────────────────────── */

let DATA = null;

const COLORS = {
  bat: '#636EFA',
  bowl: '#00CC96',
  aei: '#EF553B',
  batLight: 'rgba(99,110,250,0.35)',
  bowlLight: 'rgba(0,204,150,0.35)',
};

const plotlyConfig = { responsive: true, displayModeBar: false };

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
  document.getElementById('boei-scale-display').textContent = `×${DATA.metadata.boei_scale}`;
}

function renderMeta() {
  const d = new Date(DATA.metadata.last_updated);
  document.getElementById('last-updated').textContent = `Last updated: ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  document.getElementById('player-count').textContent = `${DATA.metadata.total_players}`;
}

// ─── Allrounder Chart ───────────────────────────────────────────────────────

function renderAllrounderChart() {
  const players = [...DATA.allrounder_top25].reverse();
  const labels = players.map(p => `${p.name} (${p.country})`);

  const traces = [
    {
      y: labels, x: players.map(p => p.BEI), type: 'bar', orientation: 'h',
      name: 'BEI', marker: { color: COLORS.bat },
      text: players.map(p => Math.round(p.BEI)), textposition: 'inside',
      hovertemplate: '%{y}<br>BEI: %{x:.0f}<extra></extra>',
    },
    {
      y: labels, x: players.map(p => p.BoEI), type: 'bar', orientation: 'h',
      name: 'BoEI', marker: { color: COLORS.bowl },
      text: players.map(p => Math.round(p.BoEI)), textposition: 'inside',
      hovertemplate: '%{y}<br>BoEI: %{x:.0f}<extra></extra>',
    },
  ];

  const layout = plotlyLayout({
    barmode: 'stack',
    height: Math.max(500, players.length * 28 + 80),
    margin: { l: 200, r: 80, t: 10, b: 30 },
    legend: { orientation: 'h', y: 1.02, x: 1, xanchor: 'right' },
    xaxis: { title: 'Allrounder Excellence Index' },
  });

  Plotly.newPlot('chart-allrounders', traces, layout, plotlyConfig);
}

// ─── Batting Chart ──────────────────────────────────────────────────────────

function renderBattingChart() {
  const players = [...DATA.batting_top25].reverse();
  const labels = players.map(p => `${p.name} (${p.country})`);

  const traces = [{
    y: labels, x: players.map(p => p.BEI), type: 'bar', orientation: 'h',
    marker: { color: COLORS.bat },
    text: players.map(p => Math.round(p.BEI)), textposition: 'inside',
    hovertemplate: '%{y}<br>BEI: %{x:.0f}<br>%{customdata} matches<extra></extra>',
    customdata: players.map(p => p.matches),
  }];

  const layout = plotlyLayout({
    height: Math.max(500, players.length * 28 + 80),
    margin: { l: 200, r: 60, t: 10, b: 30 },
    xaxis: { title: 'Batting Excellence Index (BEI)' },
    showlegend: false,
  });

  Plotly.newPlot('chart-batting', traces, layout, plotlyConfig);
}

// ─── Bowling Chart ──────────────────────────────────────────────────────────

function renderBowlingChart() {
  const players = [...DATA.bowling_top25].reverse();
  const labels = players.map(p => `${p.name} (${p.country})`);

  const traces = [{
    y: labels, x: players.map(p => p.BoEI), type: 'bar', orientation: 'h',
    marker: { color: COLORS.bowl },
    text: players.map(p => Math.round(p.BoEI)), textposition: 'inside',
    hovertemplate: '%{y}<br>BoEI: %{x:.0f}<br>%{customdata} matches<extra></extra>',
    customdata: players.map(p => p.matches),
  }];

  const layout = plotlyLayout({
    height: Math.max(500, players.length * 28 + 80),
    margin: { l: 200, r: 60, t: 10, b: 30 },
    xaxis: { title: 'Bowling Excellence Index (BoEI)' },
    showlegend: false,
  });

  Plotly.newPlot('chart-bowling', traces, layout, plotlyConfig);
}

// ─── Tables ─────────────────────────────────────────────────────────────────

function renderAllrounderTable() {
  const tbody = document.querySelector('#table-allrounders tbody');
  tbody.innerHTML = DATA.allrounder_top25.map((p, i) => `
    <tr class="${i < 3 ? 'top3' : ''}" data-player="${p.name}">
      <td class="rank">${i + 1}</td>
      <td class="name">${p.name}</td>
      <td class="country">${p.country}</td>
      <td class="metric">${Math.round(p.BEI)}</td>
      <td class="metric">${Math.round(p.BoEI)}</td>
      <td class="metric"><strong>${Math.round(p.AEI)}</strong></td>
      <td class="metric">${p.balance}%</td>
      <td class="metric">${p.matches}</td>
    </tr>
  `).join('');
  addTableClickHandlers(tbody);
}

function renderBattingTable() {
  const tbody = document.querySelector('#table-batting tbody');
  tbody.innerHTML = DATA.batting_top25.map((p, i) => `
    <tr class="${i < 3 ? 'top3' : ''}" data-player="${p.name}">
      <td class="rank">${i + 1}</td>
      <td class="name">${p.name}</td>
      <td class="country">${p.country}</td>
      <td class="metric"><strong>${Math.round(p.BEI)}</strong></td>
      <td class="metric">${p.matches}</td>
    </tr>
  `).join('');
  addTableClickHandlers(tbody);
}

function renderBowlingTable() {
  const tbody = document.querySelector('#table-bowling tbody');
  tbody.innerHTML = DATA.bowling_top25.map((p, i) => `
    <tr class="${i < 3 ? 'top3' : ''}" data-player="${p.name}">
      <td class="rank">${i + 1}</td>
      <td class="name">${p.name}</td>
      <td class="country">${p.country}</td>
      <td class="metric"><strong>${Math.round(p.BoEI)}</strong></td>
      <td class="metric">${p.matches}</td>
    </tr>
  `).join('');
  addTableClickHandlers(tbody);
}

function addTableClickHandlers(tbody) {
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const name = tr.dataset.player;
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
    `<th class="${a === '0.75' ? 'alpha-current' : ''}">&alpha;=${a}</th>`
  ).join('')}</tr>`;

  let rows = '';
  for (let rank = 0; rank < 15; rank++) {
    rows += `<tr><td class="alpha-rank">${rank + 1}</td>`;
    for (const a of alphas) {
      const list = dataSets[a];
      if (rank < list.length) {
        const p = list[rank];
        const name = p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name;
        rows += `<td class="${a === '0.75' ? 'alpha-current' : ''}">${name} <span style="color:var(--text-muted)">${Math.round(p[metricKey])}</span></td>`;
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
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) {
      results.classList.remove('open');
      return;
    }

    const matches = DATA.all_players
      .filter(p => p.name.toLowerCase().includes(q))
      .slice(0, 15);

    if (matches.length === 0) {
      results.innerHTML = '<div class="search-result"><span class="sr-name">No results</span></div>';
    } else {
      results.innerHTML = matches.map(p => `
        <div class="search-result" data-name="${p.name}">
          <span class="sr-name">${p.name}</span>
          <span class="sr-meta">${p.country} · ${p.matches}m · AEI ${Math.round(p.AEI)}</span>
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
      const q = input.value.trim().toLowerCase();
      const match = DATA.all_players.find(p => p.name.toLowerCase().includes(q));
      if (match) {
        input.value = match.name;
        results.classList.remove('open');
        showPlayer(match.name);
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
      <div class="ph-name">${player.name}</div>
      <div class="ph-country">${player.country} · ${player.matches} matches</div>
    </div>
    <div class="ph-stats">
      <div class="ph-stat"><div class="label">BEI</div><div class="value bei">${Math.round(player.BEI)}</div></div>
      <div class="ph-stat"><div class="label">BoEI</div><div class="value boei">${Math.round(player.BoEI)}</div></div>
      <div class="ph-stat"><div class="label">AEI</div><div class="value aei">${Math.round(player.AEI)}</div></div>
    </div>
  `;

  renderPlayerCareer(player);
}

function renderPlayerCareer(player) {
  const stints = player.stints;
  const labels = stints.map(s => s.label);
  const batVals = stints.map(s => s.bat_avg);
  const bowlVals = stints.map(s => s.bowl_score);

  const traces = [];

  // Row 1: Batting bars + spline
  traces.push({
    x: labels, y: batVals, type: 'bar', name: 'Bat Score',
    marker: { color: batVals.map(v => v != null ? COLORS.bat : '#555') },
    opacity: 0.4, text: batVals.map(v => v != null ? v.toFixed(1) : ''),
    textposition: 'outside', cliponaxis: false, showlegend: false,
    hovertemplate: '%{x}<br>Bat Score: %{y:.1f}<extra></extra>',
    xaxis: 'x', yaxis: 'y',
  });

  const validBat = batVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
  if (validBat.length >= 2) {
    const splineBat = splineInterp(validBat, labels);
    traces.push({
      x: splineBat.x, y: splineBat.y, type: 'scatter', mode: 'lines',
      line: { color: COLORS.bat, width: 3, shape: 'spline' }, showlegend: false,
      hovertemplate: 'Bat Score: %{y:.1f}<extra></extra>',
      xaxis: 'x', yaxis: 'y',
    });
  }

  // Row 2: Bowling bars + spline
  traces.push({
    x: labels, y: bowlVals, type: 'bar', name: 'Bowl Score',
    marker: { color: bowlVals.map(v => v != null ? COLORS.bowl : '#555') },
    opacity: 0.4, text: bowlVals.map(v => v != null ? v.toFixed(1) : ''),
    textposition: 'outside', cliponaxis: false, showlegend: false,
    hovertemplate: '%{x}<br>Bowl Score: %{y:.1f}<extra></extra>',
    xaxis: 'x2', yaxis: 'y2',
  });

  const validBowl = bowlVals.map((v, i) => v != null ? [i, v] : null).filter(Boolean);
  if (validBowl.length >= 2) {
    const splineBowl = splineInterp(validBowl, labels);
    traces.push({
      x: splineBowl.x, y: splineBowl.y, type: 'scatter', mode: 'lines',
      line: { color: COLORS.bowl, width: 3, shape: 'spline' }, showlegend: false,
      hovertemplate: 'Bowl Score: %{y:.1f}<extra></extra>',
      xaxis: 'x2', yaxis: 'y2',
    });
  }

  // Row 3: KDE of stint scores
  const batValid = batVals.filter(v => v != null);
  const bowlValid = bowlVals.filter(v => v != null);

  if (batValid.length >= 3) {
    const kde = simpleKDE(batValid);
    traces.push({
      x: kde.x, y: kde.y, type: 'scatter', mode: 'lines', name: 'Batting',
      line: { color: COLORS.bat, width: 2.5 }, fill: 'tozeroy', opacity: 0.35,
      xaxis: 'x3', yaxis: 'y3',
    });
  }
  if (bowlValid.length >= 3) {
    const kde = simpleKDE(bowlValid);
    traces.push({
      x: kde.x, y: kde.y, type: 'scatter', mode: 'lines', name: 'Bowling',
      line: { color: COLORS.bowl, width: 2.5 }, fill: 'tozeroy', opacity: 0.35,
      xaxis: 'x3', yaxis: 'y3',
    });
  }

  const batMax = Math.max(...batVals.filter(v => v != null), 10);
  const bowlMax = Math.max(...bowlVals.filter(v => v != null), 10);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gc = isDark ? '#2a2e3d' : '#dfe1e8';

  const layout = {
    ...plotlyLayout(),
    height: 750,
    grid: { rows: 3, columns: 1, subplots: [['xy'], ['x2y2'], ['x3y3']], roworder: 'top to bottom' },
    xaxis: { gridcolor: gc, domain: [0, 1], anchor: 'y' },
    yaxis: { title: 'Bat Score', range: [0, batMax * 1.3], gridcolor: gc, domain: [0.72, 1], anchor: 'x' },
    xaxis2: { gridcolor: gc, domain: [0, 1], anchor: 'y2' },
    yaxis2: { title: 'Bowl Score', range: [0, bowlMax * 1.3], gridcolor: gc, domain: [0.38, 0.66], anchor: 'x2' },
    xaxis3: { title: 'Score', gridcolor: gc, domain: [0, 1], anchor: 'y3' },
    yaxis3: { title: 'Density', showticklabels: false, gridcolor: gc, domain: [0, 0.28], anchor: 'x3' },
    annotations: [
      { text: 'Batting Score per Stint', xref: 'paper', yref: 'paper', x: 0.5, y: 1.02, showarrow: false, font: { size: 13, color: isDark ? '#e4e6ed' : '#1a1d27' } },
      { text: 'Bowling Score per Stint', xref: 'paper', yref: 'paper', x: 0.5, y: 0.68, showarrow: false, font: { size: 13, color: isDark ? '#e4e6ed' : '#1a1d27' } },
      { text: 'Score Distribution (KDE)', xref: 'paper', yref: 'paper', x: 0.5, y: 0.3, showarrow: false, font: { size: 13, color: isDark ? '#e4e6ed' : '#1a1d27' } },
    ],
    legend: { orientation: 'h', y: -0.05, x: 0.5, xanchor: 'center' },
    margin: { l: 60, r: 30, t: 30, b: 50 },
  };

  Plotly.newPlot('chart-player-career', traces, layout, plotlyConfig);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function splineInterp(validPoints, labels) {
  // Returns labels at valid points for Plotly's built-in spline
  return {
    x: validPoints.map(([i]) => labels[i]),
    y: validPoints.map(([, v]) => v),
  };
}

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

  // Trigger Plotly resize after tab switch (fixes hidden chart sizing)
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
