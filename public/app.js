(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

  const state = { overview: null, trend: [], summary: null, commits: [], date: null, token: null, drawn: false, key: '' };

  // --- helpers ---------------------------------------------------------------
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(path, { method: opts.method || 'GET', headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || body.reason || res.statusText);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  const utcNoon = (d) => new Date(`${d}T12:00:00Z`);
  const shift = (d, n) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  const dayLong = (d) => {
    const sameYear = d.slice(0, 4) === state.overview.today.slice(0, 4);
    return utcNoon(d).toLocaleDateString('en-US', {
      timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
    });
  };
  const dayShort = (d) => utcNoon(d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
  const stamp = (iso) =>
    new Date(iso).toLocaleString('en-GB', {
      timeZone: state.overview.timezone, day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hr ago`;
    return `${plural(Math.floor(h / 24), 'day')} ago`;
  };
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;

  // --- header ------------------------------------------------------------------
  function renderStatus() {
    const o = state.overview;
    let s = 'idle';
    let t = 'Waiting for the first push';
    if (!o.secret_configured) { s = 'warn'; t = 'Webhook secret missing, so deliveries are rejected'; }
    else if (o.last_push_at) { s = 'ok'; t = `Last push ${ago(o.last_push_at)}`; }
    $('#status').dataset.state = s;
    $('#status-text').textContent = t;
  }

  // --- the note ----------------------------------------------------------------
  const TRIGGER = { scheduled: 'by the daily job', catchup: 'on restart, to catch up', manual: 'manually' };

  function renderNote() {
    const { overview: o, summary: s, date } = state;
    const nothingYet = o.totals.commits === 0;
    $('#repo').textContent = `${o.repo || 'No repository yet'} (times shown in ${o.timezone})`;
    $('#day-title').textContent = dayLong(date);

    $('#headline').innerHTML = nothingYet
      ? 'No commits recorded yet. Point a GitHub webhook at <code>/webhook/github</code>, or run <code>npm run seed</code> to load demo data.'
      : esc(s.headline);

    let text = '';
    if (!nothingYet) {
      if (s.source === 'saved') text = `Saved ${stamp(s.generated_at)} ${TRIGGER[s.trigger] || ''}.`;
      else if (date >= o.today) text = `Live view of today so far. The summary is saved automatically after midnight (${o.timezone}).`;
      else if (s.total_commits > 0) text = 'No summary was saved for this day, so this one is computed live.';
    }
    $('#provenance').textContent = text;

    const btn = $('#save-btn');
    btn.hidden = nothingYet || s.total_commits === 0;
    btn.textContent = s.source === 'saved' ? 'Update saved summary' : 'Save summary now';

    $('#date-input').value = date;
    $('#date-input').max = o.today;
    $('#next').disabled = date >= o.today;
    $('#today').disabled = date === o.today;
  }

  // --- the pulse trace ---------------------------------------------------------
  function renderTrace() {
    const host = $('#trace');
    const days = state.trend;
    if (!days.length) return;
    const W = Math.max(320, host.clientWidth);
    const H = 214;
    const slot = W / days.length;
    const y0 = 138;
    const maxH = y0 - 34;
    const max = Math.max(4, ...days.map((d) => d.commits));
    const narrow = slot < 34;

    let path = `M0 ${y0}`;
    const peaks = [];
    days.forEach((day, i) => {
      const cx = slot * i + slot / 2;
      const h = day.commits ? Math.max(12, (day.commits / max) * maxH) : 0;
      if (!h) { path += ` L${(cx + slot / 2).toFixed(1)} ${y0}`; return; }
      const p = (dx, dy) => ` L${(cx + dx * slot).toFixed(1)} ${(y0 + dy).toFixed(1)}`;
      path += p(-0.3, 0) + p(-0.22, -h * 0.14) + p(-0.14, 0) + p(-0.07, h * 0.1) + p(0, -h) +
              p(0.07, h * 0.24) + p(0.13, 0) + p(0.25, -h * 0.18) + p(0.34, 0) + p(0.5, 0);
      peaks.push({ i, cx, y: y0 - h, n: day.commits });
    });

    const parts = [];
    parts.push(`<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Commits per day">`);
    parts.push(`<defs>
      <pattern id="g-minor" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" class="g-minor"/></pattern>
      <pattern id="g-major" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" class="g-major"/></pattern>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g-minor)"/><rect width="${W}" height="${H}" fill="url(#g-major)"/>`);

    days.forEach((day, i) => {
      if (day.date === state.date) parts.push(`<rect class="band" x="${(slot * i).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"/>`);
    });

    parts.push(`<path class="trace-line${state.drawn ? '' : ' draw'}" pathLength="1" d="${path}"/>`);

    peaks.forEach((pk) => {
      if (days[pk.i].date === state.date) parts.push(`<circle class="peak-dot" cx="${pk.cx.toFixed(1)}" cy="${pk.y.toFixed(1)}" r="5"/>`);
      parts.push(`<text class="peak-label" x="${pk.cx.toFixed(1)}" y="${(pk.y - 9).toFixed(1)}">${pk.n}</text>`);
    });

    days.forEach((day, i) => {
      const cx = slot * i + slot / 2;
      const sel = day.date === state.date;
      const name = day.is_today ? 'Today' : dayShort(day.date);
      parts.push(`<g class="${sel ? 'is-selected' : ''}">
        <text class="day-num" x="${cx.toFixed(1)}" y="188">${Number(day.date.slice(8))}</text>
        ${narrow ? '' : `<text class="day-name" x="${cx.toFixed(1)}" y="203">${esc(name)}</text>`}
        ${day.saved ? `<circle class="saved-dot" cx="${cx.toFixed(1)}" cy="170" r="2.6"/>` : ''}
      </g>`);
    });

    days.forEach((day, i) => {
      const label = `${dayLong(day.date)}: ${plural(day.commits, 'commit')}${day.saved ? ', summary saved' : ''}`;
      parts.push(`<rect class="hit" x="${(slot * i).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"
        tabindex="0" role="button" aria-pressed="${day.date === state.date}" aria-label="${esc(label)}" data-date="${day.date}"><title>${esc(label)}</title></rect>`);
    });
    parts.push('</svg>');
    host.innerHTML = parts.join('');
    state.drawn = true;
    if (state.refocus) {
      const el = host.querySelector(`.hit[data-date="${state.refocus}"]`);
      if (el) el.focus();
      state.refocus = null;
    }
  }

  // --- who / commits / vitals / hours ------------------------------------------
  function renderWho() {
    const list = state.summary.contributors;
    if (!list.length) { $('#who').innerHTML = '<p class="empty">Nobody committed on this day.</p>'; return; }
    const max = list[0].commits;
    $('#who').innerHTML = list.map((c) => {
      const span = c.first_time === c.last_time ? c.first_time : `${c.first_time} to ${c.last_time}`;
      const alias = c.display_name && c.display_name !== c.name ? `<small>${esc(c.display_name)}</small>` : '';
      return `<div class="who-row">
        <div class="who-name">${esc(c.name)}${alias}<small>${esc(span)}</small></div>
        <div class="bar" role="img" aria-label="${esc(c.name)}: ${plural(c.commits, 'commit')}"><span style="width:${(c.commits / max) * 100}%"></span></div>
        <div class="who-count">${c.commits}</div>
      </div>`;
    }).join('');
  }

  function renderCommits() {
    const list = state.commits;
    $('#commits').innerHTML = list.length
      ? list.map((c) => {
          const url = safeUrl(c.url);
          const sha = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(c.short_sha)}</a>` : esc(c.short_sha);
          const first = String(c.message).split('\n')[0] || '(no message)';
          return `<li><span class="c-time">${esc(c.time)}</span>
            <div><span class="c-msg">${esc(first)}</span>${c.is_merge ? '<span class="tag">merge</span>' : ''}
            <span class="c-meta">${esc(c.contributor)}${c.branch ? ` on ${esc(c.branch)}` : ''}, ${sha}</span></div></li>`;
        }).join('')
      : '<li class="empty" style="display:block;border:0">No commits on this day.</li>';
  }

  function renderVitals() {
    const s = state.summary;
    const c = s.comparison;
    let pace = ['Nothing to compare', ''];
    if (c.trend !== 'no-baseline') {
      const base = `${c.baseline_days}-day average: ${c.average} a day`;
      pace = c.delta_pct == null ? ['Above average', base] : [`${c.delta_pct > 0 ? '+' : ''}${c.delta_pct}%`, base];
    }
    const rows = [
      ['Commits', s.total_commits, ''],
      ['Contributors', s.contributor_count, ''],
      ['Vs. recent days', pace[0], pace[1]],
      ['Busiest hour', s.peak_hour == null ? 'None' : hh(s.peak_hour), s.peak_hour == null ? '' : plural(s.hourly[s.peak_hour], 'commit')],
      ['First commit', s.first_commit_time || 'None', ''],
      ['Last commit', s.last_commit_time || 'None', ''],
      ['Merge commits', s.merge_commits, ''],
    ];
    $('#vitals').innerHTML = rows
      .map(([k, v, note]) => `<div><dt>${esc(k)}</dt><span class="lead"></span><dd>${esc(v)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`)
      .join('');
  }

  function renderHours() {
    const h = state.summary.hourly;
    const max = Math.max(1, ...h);
    const desc = h.map((n, i) => (n ? `${hh(i)}: ${n}` : null)).filter(Boolean).join(', ') || 'no commits';
    $('#hours').innerHTML = `<div class="hours" role="img" aria-label="Commits by hour of day. ${esc(desc)}">
      ${h.map((n, i) => `<i data-n="${n}" title="${hh(i)}, ${plural(n, 'commit')}" style="height:${(n / max) * 100}%"></i>`).join('')}
    </div>
    <div class="hour-scale" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
  }

  function renderAll() {
    renderStatus();
    renderNote();
    renderTrace();
    renderWho();
    renderCommits();
    renderVitals();
    renderHours();
  }

  // --- data loading --------------------------------------------------------------
  async function refresh({ force = false } = {}) {
    const overview = await api('/api/overview');
    if (!state.date) state.date = overview.today;
    const [trend, summary, commits] = await Promise.all([
      api('/api/trend?days=14'),
      api(`/api/summaries/${state.date}`),
      api(`/api/commits?date=${state.date}`),
    ]);
    state.overview = overview;
    const key = JSON.stringify([overview.totals, overview.last_saved_date, trend, summary, commits, state.date]);
    if (!force && key === state.key) { renderStatus(); return; } // nothing changed; keep focus and hover as they are
    Object.assign(state, { trend, summary, commits, key });
    renderAll();
  }

  function select(date) {
    if (!date || date > state.overview.today || date === state.date) return;
    state.date = date;
    refresh({ force: true }).catch(showError);
  }

  function showError(err) {
    console.error(err);
    $('#status').dataset.state = 'warn';
    $('#status-text').textContent = 'Cannot reach the Commit Doctor server';
  }

  async function saveNow() {
    const btn = $('#save-btn');
    btn.disabled = true;
    try {
      const saved = await api(`/api/summaries/${state.date}/generate`, { method: 'POST', token: state.token });
      await refresh({ force: true });
      if (state.date >= state.overview.today) {
        $('#provenance').textContent = `Saved ${stamp(saved.summary.generated_at)}. Today stays live and is saved again after midnight.`;
      }
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to save summaries. Enter it:');
        if (t) { state.token = t; btn.disabled = false; return saveNow(); }
      } else {
        $('#provenance').textContent = `Not saved: ${err.body && err.body.reason ? err.body.reason : err.message}`;
      }
    }
    btn.disabled = false;
    return undefined;
  }

  // --- system log ----------------------------------------------------------------
  async function loadLog() {
    const a = await api('/api/activity?limit=25');
    const pill = (s) => `<span class="${s === 'accepted' || s === 'saved' ? 'pill-ok' : s === 'rejected' ? 'pill-bad' : ''}">${esc(s)}</span>`;
    const deliveries = a.webhook_events.length
      ? `<table><thead><tr><th>Received</th><th>Event</th><th>Result</th><th>Stored</th><th>Note</th></tr></thead><tbody>${a.webhook_events
          .map((e) => `<tr><td>${esc(stamp(e.received_at))}</td><td>${esc(e.event || '')}</td><td>${pill(e.status)}</td><td>${e.commits_new} of ${e.commits_received}</td><td class="wrap">${esc(e.detail || '')}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">No deliveries yet.</p>';
    const runs = a.summary_runs.length
      ? `<table><thead><tr><th>Run</th><th>Day</th><th>Trigger</th><th>Result</th><th>Commits</th></tr></thead><tbody>${a.summary_runs
          .map((r) => `<tr><td>${esc(stamp(r.run_at))}</td><td>${esc(r.date)}</td><td>${esc(r.trigger)}</td><td>${pill(r.outcome)}</td><td>${r.total_commits}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">No summaries generated yet.</p>';
    $('#log-body').innerHTML = `<div><h3>Webhook deliveries</h3><div class="tbl-wrap">${deliveries}</div></div>
      <div><h3>Summary runs</h3><div class="tbl-wrap">${runs}</div></div>`;
  }

  // --- wiring --------------------------------------------------------------------
  function bind() {
    $('#prev').addEventListener('click', () => select(shift(state.date, -1)));
    $('#next').addEventListener('click', () => select(shift(state.date, 1)));
    $('#today').addEventListener('click', () => select(state.overview.today));
    $('#date-input').addEventListener('change', (e) => select(e.target.value));
    $('#save-btn').addEventListener('click', saveNow);

    const trace = $('#trace');
    trace.addEventListener('click', (e) => { const r = e.target.closest('.hit'); if (r) select(r.dataset.date); });
    trace.addEventListener('keydown', (e) => {
      const r = e.target.closest('.hit');
      if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); state.refocus = r.dataset.date; select(r.dataset.date); }
    });

    $('#log').addEventListener('toggle', (e) => { if (e.target.open) loadLog().catch(showError); });

    let t;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => state.trend.length && renderTrace(), 150); });
    setInterval(() => {
      if (document.hidden) return;
      refresh().catch(showError);
      if ($('#log').open) loadLog().catch(() => {});
    }, 30000);
  }

  bind();
  refresh({ force: true }).catch(showError);
})();
