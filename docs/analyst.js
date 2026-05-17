/* ─── Cricket Analyst Client ────────────────────────────────────────────────
 *
 * Talks to the Cloudflare Worker's /agent/* routes, which proxy to the
 * Modal-hosted LangGraph agent. Renders the agent's events live as they
 * arrive over SSE: plan → tool calls → draft → critique → final verdict.
 *
 * Configuration:
 *   AGENT_ENDPOINT is the same worker URL used by llm.js (LLM_ENDPOINT).
 *   The worker routes `/agent/ask*` to the Modal app; everything else
 *   stays on the direct Anthropic path.
 * ──────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const ENDPOINT = (typeof LLM_ENDPOINT === 'string' ? LLM_ENDPOINT : '').replace(/\/$/, '');
  const ASK_STREAM = `${ENDPOINT}/agent/ask/stream`;
  const ASK_APPROVE = `${ENDPOINT}/agent/ask/approve`;

  let CURRENT_SESSION = null;
  let CURRENT_AWAITING_APPROVAL = false;

  function $(id) { return document.getElementById(id); }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function setText(id, text) { $(id).textContent = text; }
  function setHTML(id, html) { $(id).innerHTML = html; }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function resetStream() {
    ['analyst-plan', 'analyst-tools', 'analyst-draft', 'analyst-critique', 'analyst-final', 'analyst-trace', 'analyst-approval', 'analyst-error']
      .forEach(hide);
    ['analyst-plan-body', 'analyst-tools-body', 'analyst-draft-body', 'analyst-critique-body', 'analyst-final-body']
      .forEach(id => setHTML(id, ''));
    show('analyst-stream');
  }

  function renderPlan(plan) {
    const html = `
      <div class="plan-row"><span class="plan-label">Format:</span> ${escapeHTML(plan.format)}</div>
      <div class="plan-row"><span class="plan-label">Why:</span> ${escapeHTML(plan.rationale)}</div>
      <div class="plan-row plan-tasks">
        <span class="plan-label">Sub-tasks:</span>
        <ol>${plan.sub_tasks.map(t => `<li>${escapeHTML(t)}</li>`).join('')}</ol>
      </div>`;
    setHTML('analyst-plan-body', html);
    show('analyst-plan');
  }

  function appendToolCall(call) {
    const body = $('analyst-tools-body');
    const argText = call.args ? ` <span class="tool-args">${escapeHTML(JSON.stringify(call.args))}</span>` : '';
    const resultText = call.result_preview
      ? `<div class="tool-result">${escapeHTML(call.result_preview)}</div>`
      : '';
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.innerHTML = `<span class="tool-name">${escapeHTML(call.tool)}</span>${argText}${resultText}`;
    body.appendChild(row);
    show('analyst-tools');
  }

  function renderDraft(draft) {
    const html = `
      <p class="draft-summary">${escapeHTML(draft.summary)}</p>
      <ul class="draft-points">${(draft.key_points || []).map(k => `<li>${escapeHTML(k)}</li>`).join('')}</ul>`;
    setHTML('analyst-draft-body', html);
    show('analyst-draft');
  }

  function renderCritique(critique) {
    const status = critique.grounded && critique.addresses_question && critique.structure_ok
      ? '<span class="critique-pass">PASS</span>'
      : '<span class="critique-fail">REVISE</span>';
    const issues = (critique.issues || []).map(i => `<li>${escapeHTML(i)}</li>`).join('');
    const html = `
      <div class="critique-status">${status}</div>
      ${issues ? `<ul class="critique-issues">${issues}</ul>` : ''}`;
    setHTML('analyst-critique-body', html);
    show('analyst-critique');
  }

  function renderFinal(final) {
    const html = `
      <p class="final-summary">${escapeHTML(final.summary)}</p>
      <ul class="final-points">${(final.key_points || []).map(k => `<li>${escapeHTML(k)}</li>`).join('')}</ul>
      ${final.cited_players?.length ? `<div class="final-cited">Cited: ${final.cited_players.map(escapeHTML).join(', ')}</div>` : ''}`;
    setHTML('analyst-final-body', html);
    show('analyst-final');
    hide('analyst-plan');
    hide('analyst-tools');
    hide('analyst-draft');
    hide('analyst-critique');
  }

  function renderError(msg) {
    setText('analyst-error', msg);
    show('analyst-error');
  }

  function renderTrace(url) {
    if (!url) return;
    $('analyst-trace-link').href = url;
    show('analyst-trace');
  }

  async function streamAgent(question, requireApproval) {
    resetStream();
    CURRENT_AWAITING_APPROVAL = false;

    const body = JSON.stringify({ question, require_approval: requireApproval });
    let resp;
    try {
      resp = await fetch(ASK_STREAM, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (e) {
      renderError('Network error: ' + e.message);
      return;
    }

    if (!resp.ok || !resp.body) {
      renderError(`Agent error (${resp.status}). Make sure the agent is deployed and AGENT_ENDPOINT is set on the worker.`);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); }
        catch { continue; }

        if (ev.kind === 'session') CURRENT_SESSION = ev.session_id;
        else if (ev.kind === 'plan') renderPlan(ev.plan);
        else if (ev.kind === 'tool_step') (ev.calls || []).forEach(appendToolCall);
        else if (ev.kind === 'draft') renderDraft(ev.draft);
        else if (ev.kind === 'critique') renderCritique(ev.critique);
        else if (ev.kind === 'final') renderFinal(ev.final);
        else if (ev.kind === 'trace_url') renderTrace(ev.url);
        else if (ev.kind === 'end') { /* graceful close */ }
      }
    }
  }

  async function askAgentSync(question, requireApproval) {
    resetStream();
    const body = JSON.stringify({ question, require_approval: requireApproval });
    const resp = await fetch(`${ENDPOINT}/agent/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!resp.ok) {
      renderError(`Agent error (${resp.status})`);
      return;
    }
    const data = await resp.json();
    CURRENT_SESSION = data.session_id;

    if (data.status === 'awaiting_approval' && data.interrupt) {
      CURRENT_AWAITING_APPROVAL = true;
      renderPlan({
        format: data.interrupt.format,
        rationale: data.interrupt.rationale,
        sub_tasks: data.interrupt.sub_tasks,
      });
      show('analyst-approval');
      return;
    }

    if (data.plan) renderPlan(data.plan);
    if (data.critique) renderCritique(data.critique);
    if (data.final) renderFinal(data.final);
    if (data.trace_url) renderTrace(data.trace_url);
  }

  async function approve(decision) {
    if (!CURRENT_SESSION) return;
    hide('analyst-approval');
    if (!decision) {
      renderError('Plan cancelled.');
      return;
    }
    const resp = await fetch(ASK_APPROVE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: CURRENT_SESSION, approved: true }),
    });
    if (!resp.ok) {
      renderError(`Approval failed (${resp.status})`);
      return;
    }
    const data = await resp.json();
    if (data.final) renderFinal(data.final);
    if (data.critique) renderCritique(data.critique);
    if (data.trace_url) renderTrace(data.trace_url);
  }

  function setupAnalystTab() {
    const send = $('analyst-send');
    const input = $('analyst-input');
    const requireApproval = $('analyst-require-approval');

    if (!send || !input) return;

    function submit() {
      const q = input.value.trim();
      if (!q) return;
      const approval = requireApproval.checked;
      if (approval) askAgentSync(q, true);
      else streamAgent(q, false);
    }

    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    document.querySelectorAll('.analyst-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        input.value = chip.textContent;
        submit();
      });
    });

    $('analyst-approve-btn').addEventListener('click', () => approve(true));
    $('analyst-cancel-btn').addEventListener('click', () => approve(false));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAnalystTab);
  } else {
    setupAnalystTab();
  }
})();
