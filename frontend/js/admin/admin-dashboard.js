(function () {
  'use strict';

  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const state = {
    period: 'today',
    dateFrom: '',
    dateTo: '',
    grain: '',
    controller: null,
    loading: false,
    data: null,
    aiBusy: false,
    timer: null,
    charts: { trend: null, byVaccine: null },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const n = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString());

  function fmtDate(ymd) {
    if (!ymd) return '—';
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    if (!y) return '—';
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtPeriodKey(key, grain) {
    if (grain === 'week') return String(key).replace(/^(\d{4})-W(\d+)$/, 'Week $2, $1');
    if (grain === 'month') {
      const [y, m] = String(key).split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    }
    return fmtDate(key);
  }

  const BADGE_CLASS = {
    'Completed': 'completed', 'Verified': 'verified', 'Available': 'available', 'Closed': 'completed',
    'Pending': 'pending', 'Pending Verification': 'pending', 'Incomplete': 'pending', 'Recorded': 'info',
    'Corrected': 'info', 'Not Started': '', 'No Vaccines': '',
    'Low Stock': 'low', 'Critical': 'critical', 'Missing': 'missing', 'Not Recorded': 'missing',
    'Missing Record': 'missing', 'Out of Stock': 'critical',
    'Expiring Soon': 'expiring', 'Expired': 'expired',
  };
  function badge(label) {
    const cls = BADGE_CLASS[label] != null ? BADGE_CLASS[label] : 'info';
    return `<span class="ad-badge ${cls}">${esc(label || '—')}</span>`;
  }

  function showBanner(msg) {
    $('adBannerText').textContent = msg || '';
    $('adBanner').classList.toggle('is-shown', Boolean(msg));
  }

  function tickClock() {
    $('adClock').textContent = new Date().toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function handleSessionExpired() {
    window.location.href = '/shared/login.html';
  }

  function buildQuery() {
    const p = new URLSearchParams({ period: state.period });
    if (state.period === 'custom') {
      p.set('date_from', state.dateFrom);
      p.set('date_to', state.dateTo);
    }
    if (state.grain) p.set('grain', state.grain);
    return p.toString();
  }

  function setLoading(on) {
    state.loading = on;
    $('adRefresh').disabled = on;
    $('adApply').disabled = on;
    if (on) $('adUpdated').textContent = 'Updating…';
    document.querySelectorAll('.ad-kpi').forEach((el) => el.classList.toggle('is-loading', on && !state.data));
  }

  async function loadDashboard() {
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/dashboard?${buildQuery()}`, {
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401) return handleSessionExpired();
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      if (res.status === 403) {
        throw new Error('You do not have permission to view the Administrator Dashboard.');
      }
      if (!res.ok || !json || !json.success) {
        throw new Error((json && json.message) || 'The dashboard could not be loaded. Please try again.');
      }
      state.data = json.data;
      showBanner('');
      render(json.data);
      $('adUpdated').textContent = `Last updated ${fmtDateTime(json.data.generatedAt)}`;
    } catch (err) {
      if (err.name === 'AbortError') return;
      showBanner(err.message || 'The dashboard could not be loaded. Please try again.');
      $('adUpdated').textContent = state.data
        ? `Showing data from ${fmtDateTime(state.data.generatedAt)}`
        : 'Not loaded';
      if (!state.data) renderLoadError();
    } finally {
      if (state.controller === controller) {
        state.controller = null;
        setLoading(false);
      }
    }
  }

  function renderLoadError() {
    const msg = '<div class="ad-error-state"><i class="fa-solid fa-circle-exclamation"></i> Data unavailable.</div>';
    ['kpiCurrent', 'kpiToday', 'alertList', 'aiStats'].forEach((id) => { $(id).innerHTML = msg; });
    $('shiftGrid').innerHTML = `<div class="ad-panel ad-span-all"><div class="ad-panel-bd">${msg}</div></div>`;
    $('invBody').innerHTML = `<tr><td colspan="7">${msg}</td></tr>`;
  }

  function kpi({ icon, label, value, tone = '', sub = '', href = '' }) {
    const content = `<div class="ad-kpi-icon"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></div>
      <div class="ad-kpi-body">
        <div class="ad-kpi-val">${esc(value)}</div>
        <div class="ad-kpi-lbl">${esc(label)}</div>
        ${sub ? `<div class="ad-kpi-sub">${sub}</div>` : ''}
      </div>`;
    
    if (href) {
      return `<a href="${esc(href)}" class="ad-kpi ${tone} ad-kpi-clickable" title="Click to view ${esc(label)}">${content}</a>`;
    }
    return `<div class="ad-kpi ${tone}">${content}</div>`;
  }

  function render(d) {
    $('adShift').innerHTML = `<i class="fa-solid fa-clock"></i> ${esc(d.currentShift || '—')}`;
    const r = d.range;
    const rangeText = r.dateFrom === r.dateTo ? fmtDate(r.dateFrom) : `${fmtDate(r.dateFrom)} – ${fmtDate(r.dateTo)}`;
    $('adRangeNote').textContent = `Date filter: ${rangeText} (${r.days} day${r.days === 1 ? '' : 's'}). `
      + 'Current Status cards always show live values.';
    $('todayLabel').textContent = fmtDate(d.clinicDate);
    $('periodLabel').textContent = rangeText;
    $('periodWrap').hidden = r.period === 'today';
    renderKpis(d);
    renderShifts(d.shifts);
    renderCharts(d);
    renderInventory(d);
    renderAlerts(d.alerts || []);
    renderAiStats(d.ai || {});
    renderActivities(d.recentActivities || []);
    renderClinic(d);
  }

  function renderKpis(d) {
    const c = d.current;
    const t = d.today;
    const p = d.period;
    $('kpiCurrent').innerHTML = [
      kpi({ icon: 'boxes-stacked', label: 'Available Vaccine Stock', value: n(c.availableStock), tone: 'ok', sub: `${n(c.lotCount)} vaccine lot record(s)`, href: '/admin/inventory.html' }),
      kpi({ icon: 'triangle-exclamation', label: 'Low Stock', value: n(c.lowStock), tone: c.lowStock ? 'warn' : '', sub: c.lowStock ? 'Current stock at or below the low-stock threshold' : 'No vaccines with low current stock', href: '/admin/ai-predictive.html#paneMonitor' }),
      kpi({ icon: 'circle-exclamation', label: 'Critical Stock', value: n(c.criticalStock), tone: c.criticalStock ? 'bad' : '', sub: c.criticalStock ? 'Current stock at or below the critical threshold' : 'No vaccines at critical stock', href: '/admin/ai-predictive.html#paneMonitor' }),
      kpi({ icon: 'hourglass-half', label: 'Expiring Soon (30 days)', value: n(c.expiringSoon), tone: c.expiringSoon ? 'warn' : '', sub: c.expiringSoon ? badge('Expiring Soon') : 'No lots expiring soon', href: '/admin/inventory.html?filter=expiring' }),
      kpi({ icon: 'ban', label: 'Expired Lots', value: n(c.expired), tone: c.expired ? 'bad' : '', sub: c.expired ? badge('Expired') : 'No expired lots', href: '/admin/inventory.html?filter=expired' }),
      // Removed: Pending Inventory Records card
      kpi({ icon: 'users', label: 'Total Patients', value: n(c.totalPatients), href: '/nurse/patients.html' }),
      kpi({ icon: 'file-medical', label: 'Total Bite Cases', value: n(c.totalBiteCases), href: '/nurse/patients.html' }),
      kpi({ icon: 'id-card', label: 'Registered Patient Accounts', value: n(c.patientAccounts), sub: c.activePatientAccounts != null ? `${n(c.activePatientAccounts)} active` : '', href: '/admin/patient-accounts.html' }),
      kpi({ icon: 'user-nurse', label: 'Active Staff', value: n(c.activeStaff), tone: 'teal', sub: `${n(c.activeNurses)} nurse(s)`, href: '/admin/staff-management.html' }),
    ].join('');
    $('kpiToday').innerHTML = [
      kpi({ icon: 'syringe', label: 'Vaccine Used Today', value: n(t.vaccineUsed), sub: 'Verified AM + additional − PM', href: `/admin/inventory.html?date=${encodeURIComponent(d.clinicDate)}` }),
      kpi({ icon: 'truck-medical', label: 'Additional Received Today', value: n(t.additionalReceived), sub: 'Recorded on the AM sheet', href: `/admin/inventory.html?date=${encodeURIComponent(d.clinicDate)}` }),
      // Removed: Inventory Transactions Today card
      kpi({ icon: 'user-plus', label: 'New Cases Today', value: n(t.newCases), sub: 'Bite cases registered today', href: '/nurse/patients.html' }),
    ].join('');
    $('kpiPeriod').innerHTML = [
      kpi({ icon: 'syringe', label: 'Vaccine Used', value: n(p.vaccineUsed), sub: 'Verified usage in period', href: '/admin/inventory-analytics.html' }),
      kpi({ icon: 'truck-medical', label: 'Additional Received', value: n(p.additionalReceived), href: '/admin/inventory-history.html' }),
      // Removed: Inventory Transactions card
      kpi({ icon: 'user-plus', label: 'New Cases', value: n(p.newCases), href: '/nurse/patients.html' }),
      kpi({ icon: 'circle-check', label: 'Completed AM/PM Records', value: n(p.completedPairs), tone: 'ok', sub: p.pendingVerification ? `${n(p.pendingVerification)} pending verification` : '', href: '/admin/inventory.html' }),
    ].join('');
  }

  function progress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return `<div class="ad-progress ${pct === 100 ? 'ok' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  }
  function missingList(names) {
    if (!names || !names.length) return '';
    return `<details class="ad-missing"><summary>${names.length} vaccine(s) not recorded</summary>${esc(names.join(', '))}</details>`;
  }

  function renderShifts(s) {
    if (!s) return;
    $('shiftLabel').textContent = fmtDate(s.date);
    const am = s.am;
    const pm = s.pm;
    const cb = s.combined;
    const staff = (list) => (list && list.length ? esc(list.join(', ')) : '—');
    const amHtml = `<div class="ad-panel"><div class="ad-panel-bd ad-shift">
      <div class="ad-shift-top"><h4><i class="fa-solid fa-sun" style="color:#d97706"></i> AM Shift</h4>${badge(am.status)}</div>
      ${progress(am.recordedVaccines, am.totalVaccines)}
      <dl class="ad-dl">
        <dt>Vaccine types recorded</dt><dd>${n(am.recordedVaccines)} / ${n(am.totalVaccines)}</dd>
        <dt>Verified counts</dt><dd>${n(am.verifiedVaccines)}</dd>
        <dt>AM inventory counted</dt><dd>${am.recordedVaccines ? n(am.totalAmCount) : '—'}</dd>
        <dt>Additional stock recorded</dt><dd>${am.recordedVaccines ? n(am.additionalRecorded) : '—'}</dd>
        <dt>Recorded by</dt><dd>${staff(am.recordedBy)}</dd>
        <dt>Last updated</dt><dd>${fmtDateTime(am.lastUpdated)}</dd>
      </dl>
      ${missingList(am.missingVaccines)}
    </div></div>`;
    const pmHtml = `<div class="ad-panel"><div class="ad-panel-bd ad-shift">
      <div class="ad-shift-top"><h4><i class="fa-solid fa-moon" style="color:#3a4d9f"></i> PM Shift</h4>${badge(pm.status)}</div>
      ${progress(pm.recordedVaccines, pm.totalVaccines)}
      <dl class="ad-dl">
        <dt>Vaccine types recorded</dt><dd>${n(pm.recordedVaccines)} / ${n(pm.totalVaccines)}</dd>
        <dt>Verified counts</dt><dd>${n(pm.verifiedVaccines)}</dd>
        <dt>PM remaining counted</dt><dd>${pm.recordedVaccines ? n(pm.totalPmCount) : '—'}</dd>
        <dt>Usage calculated</dt><dd>${pm.usageCalculatedVaccines ? `${n(pm.calculatedUsage)} (${n(pm.usageCalculatedVaccines)} vaccine types)` : '—'}</dd>
        <dt>Recorded by</dt><dd>${staff(pm.recordedBy)}</dd>
        <dt>Last updated</dt><dd>${fmtDateTime(pm.lastUpdated)}</dd>
      </dl>
      ${missingList(pm.missingVaccines)}
    </div></div>`;
    const warnings = [];
    if (cb.missingAm && am.status !== 'Not Started') warnings.push(`${cb.missingAm} vaccine type(s) without an AM record`);
    if (cb.missingPm && pm.status !== 'Not Started') warnings.push(`${cb.missingPm} vaccine type(s) without a PM record`);
    if (am.pendingVerification + pm.pendingVerification > 0) warnings.push(`${am.pendingVerification + pm.pendingVerification} count(s) pending verification`);
    if (cb.varianceCount) warnings.push(`${cb.varianceCount} vaccine(s) with a stock variance`);
    const cbHtml = `<div class="ad-panel ad-span-all"><div class="ad-panel-bd ad-shift">
      <div class="ad-shift-top"><h4><i class="fa-solid fa-circle-half-stroke" style="color:#4274D9"></i> Daily Inventory Status</h4>${badge(cb.status)}</div>
      ${progress(cb.bothCompleted, cb.totalVaccines)}
      <dl class="ad-dl">
        <dt>Both shifts recorded</dt><dd>${n(cb.bothCompleted)} / ${n(cb.totalVaccines)}</dd>
        <dt>Missing AM records</dt><dd>${n(cb.missingAm)}</dd>
        <dt>Missing PM records</dt><dd>${n(cb.missingPm)}</dd>
        <dt>Last updated</dt><dd>${fmtDateTime(cb.lastUpdated)}</dd>
      </dl>
      ${warnings.length ? `<ul class="ad-ai-list" style="color:#b45309">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <a class="ad-link" href="/admin/inventory.html?date=${encodeURIComponent(s.date)}">Open AM/PM inventory for this date <i class="fa-solid fa-arrow-right"></i></a>
    </div></div>`;
    $('shiftGrid').innerHTML = amHtml + pmHtml + cbHtml;
  }

  function chartEmpty(canvas, message) {
    const box = canvas.parentElement;
    let empty = box.querySelector('.ad-empty');
    if (!message) {
      if (empty) empty.remove();
      canvas.style.visibility = 'visible';
      return;
    }
    canvas.style.visibility = 'hidden';
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'ad-empty';
      box.appendChild(empty);
    }
    empty.innerHTML = `<i class="fa-solid fa-chart-simple"></i>${esc(message)}`;
  }

  function upsertChart(key, canvasId, config, emptyMessage) {
    const canvas = $(canvasId);
    if (typeof Chart === 'undefined') {
      chartEmpty(canvas, 'Charts could not be loaded. Check your internet connection.');
      return;
    }
    if (emptyMessage) {
      if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
      chartEmpty(canvas, emptyMessage);
      return;
    }
    chartEmpty(canvas, null);
    const existing = state.charts[key];
    if (existing && existing.config.type === config.type) {
      existing.data = config.data;
      existing.options = config.options;
      existing.update('none');
      return;
    }
    if (existing) existing.destroy();
    state.charts[key] = new Chart(canvas, config);
  }

  function renderCharts(d) {
    const series = (d.charts && d.charts.usageSeries) || [];
    const grain = d.range.grain;
    const hasTrend = series.some((p) => Number(p.used) > 0 || Number(p.additional) > 0);
    const pointRadius = series.length < 2 ? 5 : 3;
    upsertChart('trend', 'chartTrend', {
      type: 'line',
      data: {
        labels: series.map((p) => fmtPeriodKey(p.period, grain)),
        datasets: [
          { label: 'Vaccine used', data: series.map((p) => Number(p.used) || 0), borderColor: '#4274D9', backgroundColor: 'rgba(66,116,217,.12)', fill: true, tension: .25, pointRadius, pointHoverRadius: pointRadius + 2, borderWidth: 2 },
          { label: 'Additional received', data: series.map((p) => Number(p.additional) || 0), borderColor: '#95CCDD', backgroundColor: 'transparent', borderDash: [5, 4], tension: .25, pointRadius: Math.max(3, pointRadius - 1), pointHoverRadius: pointRadius + 1, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, clip: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 14, right: 16, left: 4, bottom: 0 } },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { position: 'nearest' },
        },
        scales: {
          x: { offset: true, ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true }, grid: { display: false } },
          y: { beginAtZero: true, grace: '15%', ticks: { precision: 0 }, grid: { color: '#eef2ff' } },
        },
      },
    }, hasTrend ? null : 'No verified vaccine usage recorded for the selected period.');

    const byVaccine = ((d.charts && d.charts.usageByVaccine) || []).slice(0, 10);
    upsertChart('byVaccine', 'chartByVaccine', {
      type: 'bar',
      data: {
        labels: byVaccine.map((x) => x.brand),
        datasets: [{ label: 'Vials used', data: byVaccine.map((x) => x.qty), backgroundColor: '#293681', borderRadius: 6 }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef2ff' } },
          y: { ticks: { font: { size: 11 } }, grid: { display: false } },
        },
      },
    }, byVaccine.length ? null : 'No vaccine usage by type for the selected period.');
  }

  function renderInventory(d) {
    const rows = d.inventorySummary || [];
    if (!rows.length) {
      $('invBody').innerHTML = '<tr><td colspan="7"><div class="ad-empty"><i class="fa-solid fa-box-open"></i>No vaccine lots are recorded in Vaccine Inventory Management.</div></td></tr>';
    } else {
      $('invBody').innerHTML = rows.map((r) => `<tr>
        <td data-label="Vaccine"><strong>${esc(r.vaccine)}</strong></td>
        <td data-label="Available Stock" class="num">${n(r.availableStock)}</td>
        <td data-label="Used (period)" class="num">${n(r.usedInPeriod)}</td>
        <td data-label="Additional (period)" class="num">${n(r.additionalInPeriod)}</td>
        <td data-label="Nearest Expiry">${fmtDate(r.nearestExpiry)}</td>
        <td data-label="Status">${badge(r.status)}</td>
        <td data-label="Last Updated">${fmtDateTime(r.lastUpdated)}</td>
      </tr>`).join('');
    }
    $('invNote').textContent = `${d.usageDefinition || ''} Available stock is the usable quantity still on hand.`;
  }

  const ALERT_ICON = {
    'Expired': 'ban', 'Critical': 'circle-exclamation', 'Low Stock': 'triangle-exclamation',
    'Expiring Soon': 'hourglass-half', 'Missing Record': 'clipboard-question', 'Pending': 'user-clock',
    'Unusual Change': 'chart-column', 'AI Analysis': 'robot',
  };
  function renderAlerts(alerts) {
    $('alertCount').textContent = String(alerts.length);
    $('alertCount').className = `ad-badge ${alerts.some((a) => a.severity === 'critical') ? 'critical' : alerts.length ? 'pending' : 'completed'}`;
    if (!alerts.length) {
      $('alertList').innerHTML = '<div class="ad-empty"><i class="fa-solid fa-circle-check" style="color:#16a34a"></i>No active alerts. Stock, expiry and AM/PM records are in order.</div>';
      return;
    }
    $('alertList').innerHTML = alerts.map((a) => `<a class="ad-alert ${esc(a.severity)}" href="${esc(a.link || '#')}">
      <i class="fa-solid fa-${ALERT_ICON[a.type] || 'bell'} ico" aria-hidden="true"></i>
      <div><div class="ad-alert-title">${esc(a.title)}</div>
      <div class="ad-alert-meta">${badge(a.type === 'Missing Record' ? 'Missing' : a.type)} ${esc(a.detail || '')}${a.date ? ` · ${String(a.date).length > 10 ? fmtDateTime(a.date) : fmtDate(a.date)}` : ''}</div></div>
    </a>`).join('');
  }

  function renderAiStats(ai) {
    const w = ai.window || {};
    const trend = ai.inventoryTrend ? ai.inventoryTrend.charAt(0).toUpperCase() + ai.inventoryTrend.slice(1) : '—';
    const fc = (ai.forecast || []).map((f) => `<li><strong>${esc(f.vaccine)}</strong>: about ${n(f.forecastUsage)} vial(s) ${esc((f.period || '').toLowerCase())} (stock ${n(f.currentStock)})${f.replenishmentWarning ? ' — replenishment recommended' : ''}</li>`).join('');
    let html = `<div class="ad-ai-grid">
      <div class="ad-ai-stat"><div class="k">Usage trend (${esc(fmtDate(w.dateFrom))} – ${esc(fmtDate(w.dateTo))})</div><div class="v">${esc(trend)}</div></div>
      <div class="ad-ai-stat"><div class="k">Most used vaccine</div><div class="v">${esc(ai.mostUsedVaccine || 'No verified usage yet')}</div></div>
      <div class="ad-ai-stat"><div class="k">Replenishment recommended</div><div class="v">${ai.replenishment && ai.replenishment.length ? esc(ai.replenishment.slice(0, 3).join(', ')) + (ai.replenishment.length > 3 ? ` +${ai.replenishment.length - 3}` : '') : 'None'}</div></div>
      <div class="ad-ai-stat"><div class="k">Forecast reliability</div><div class="v">${ai.dataSufficient ? 'Sufficient history' : 'Limited history'}</div></div>
    </div>
    <div class="ad-ai-block"><h5><i class="fa-solid fa-chart-line"></i> Statistical usage forecast</h5>
      ${fc ? `<ul class="ad-ai-list">${fc}</ul>` : '<p class="ad-note">Not enough verified usage to estimate future demand.</p>'}
      <p class="ad-note">${esc(ai.forecastNote || '')}</p></div>`;
    const last = ai.lastAnalysis;
    if (last && (last.insights.length || last.recommendations.length)) {
      html += `<div class="ad-ai-block"><h5><i class="fa-solid fa-robot"></i> Last AI analysis · ${esc(fmtDateTime(last.generatedAt))}</h5>
        <p class="ad-note">Covers ${esc(fmtDate(last.periodStart))} – ${esc(fmtDate(last.periodEnd))}. Data may have changed since it was generated.</p>
        ${last.insights.length ? `<ul class="ad-ai-list">${last.insights.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
        ${last.recommendations.length ? `<p class="ad-note" style="margin-top:6px;font-weight:600;color:#293681">Recommendations</p><ul class="ad-ai-list">${last.recommendations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      </div>`;
    } else {
      html += '<p class="ad-note" style="margin-top:10px">No AI analysis has been generated yet. Use Generate AI Analysis to create one.</p>';
    }
    if (ai.lastFailureAt) {
      html += `<p class="ad-ai-status error"><i class="fa-solid fa-circle-exclamation"></i> The last AI request failed on ${esc(fmtDateTime(ai.lastFailureAt))}. Statistical insights remain available.</p>`;
    }
    $('aiStats').innerHTML = html;
  }

  async function generateAi() {
    if (state.aiBusy || !state.data) return;
    state.aiBusy = true;
    const btn = $('aiGenerate');
    const status = $('aiStatus');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';
    status.className = 'ad-ai-status';
    status.textContent = 'Generating AI analysis from aggregated data…';
    const w = (state.data.ai && state.data.ai.window) || {};
    const q = new URLSearchParams({ interpret: '1' });
    if (w.dateFrom) q.set('date_from', w.dateFrom);
    if (w.dateTo) q.set('date_to', w.dateTo);
    try {
      const res = await fetch(`/api/admin/analytics/ai-insights?${q}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.status === 401) return handleSessionExpired();
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      if (res.status === 403) throw new Error('You do not have permission to generate AI analysis.');
      if (!res.ok || !json || !json.success || !json.data || !json.data.aiUsed) {
        throw new Error((json && json.message) || 'AI analysis is temporarily unavailable. Statistical insights are still available.');
      }
      const a = json.data;
      const list = (items) => (items && items.length ? `<ul class="ad-ai-list">${items.slice(0, 4).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '');
      $('aiResult').innerHTML = `<div class="ad-ai-block"><h5><i class="fa-solid fa-wand-magic-sparkles"></i> New AI analysis</h5>
        ${list(a.insights)}
        ${a.recommendations && a.recommendations.length ? `<p class="ad-note" style="margin-top:6px;font-weight:600;color:#293681">Recommendations</p>${list(a.recommendations)}` : ''}
        ${a.limitations ? `<p class="ad-note">${esc(a.limitations)}</p>` : ''}</div>`;
      status.className = 'ad-ai-status ok';
      status.textContent = `AI analysis generated ${fmtDateTime(a.generatedAt)}${a.aiModel ? ` (Groq · ${a.aiModel})` : ''}.`;
    } catch (err) {
      status.className = 'ad-ai-status error';
      status.textContent = err.message;
    } finally {
      state.aiBusy = false;
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate AI Analysis';
    }
  }

  function renderActivities(acts) {
    if (!acts.length) {
      $('actBody').innerHTML = '<tr><td colspan="7"><div class="ad-empty"><i class="fa-solid fa-inbox"></i>No inventory activity in the selected period.</div></td></tr>';
      return;
    }
    $('actBody').innerHTML = acts.map((a) => `<tr>
      <td data-label="Date &amp; Time">${fmtDateTime(a.date)}</td>
      <td data-label="Activity">${esc(a.type)}</td>
      <td data-label="Vaccine"><strong>${esc(a.vaccine)}</strong></td>
      <td data-label="Quantity" class="num">${a.quantity == null || a.quantity === '' ? '—' : n(a.quantity)}</td>
      <td data-label="Shift">${esc(a.shift)}</td>
      <td data-label="Staff">${esc(a.staff)}</td>
      <td data-label="Status">${badge(a.status)}</td>
    </tr>`).join('');
  }

  function renderClinic(d) {
    const c = d.current;
    const p = d.period;
    const stat = (v, k) => `<div class="ad-stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`;
    // Clinic Statistics section removed - keeping code commented for reference
    /*
    $('clinicStats').innerHTML = [
      stat(n(c.totalPatients), 'Total patients'),
      stat(n(c.totalBiteCases), 'Total bite cases'),
      stat(n(p.newCases), 'New cases in period'),
      stat(n(c.completedVaccinations), 'Completed vaccinations'),
      stat(n(c.ongoingVaccinations), 'Ongoing vaccinations'),
      stat(n(c.overdueVaccinations), 'Overdue vaccinations'),
      stat(n(c.activeStaff), 'Active staff'),
      stat(n(c.activeNurses), 'Active nurses'),
      stat(n(c.patientAccounts), 'Patient accounts'),
      stat(p.topBarangay ? `${p.topBarangay.name}` : '—', p.topBarangay ? `Most cases in period (${p.topBarangay.cases})` : 'Most cases in period'),
    ].join('');
    */
  }

  function selectPeriod(period) {
    state.period = period;
    document.querySelectorAll('#adPeriods button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.period === period));
    });
    $('adCustom').classList.toggle('is-open', period === 'custom');
    if (period !== 'custom') loadDashboard();
  }

  function applyCustom() {
    const from = $('adFrom').value;
    const to = $('adTo').value;
    if (!from || !to) return showBanner('Select both a start date and an end date.');
    if (from > to) return showBanner('The end date cannot be earlier than the start date.');
    state.dateFrom = from;
    state.dateTo = to;
    loadDashboard();
  }

  function scheduleAutoRefresh() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (!document.hidden && !state.loading) loadDashboard();
    }, AUTO_REFRESH_MS);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const auth = await checkAuth();
    if (auth && auth.loggedIn === false) return;
    tickClock();
    setInterval(tickClock, 30000);
    document.querySelectorAll('#adPeriods button').forEach((b) => {
      b.addEventListener('click', () => selectPeriod(b.dataset.period));
    });
    $('adApply').addEventListener('click', applyCustom);
    $('adRefresh').addEventListener('click', () => { if (!state.loading) loadDashboard(); });
    $('adGrain').addEventListener('change', (e) => { state.grain = e.target.value; loadDashboard(); });
    $('aiGenerate').addEventListener('click', generateAi);
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    $('adFrom').max = iso;
    $('adTo').max = iso;
    loadDashboard();
    scheduleAutoRefresh();
    window.addEventListener('pagehide', () => {
      if (state.timer) clearInterval(state.timer);
      Object.values(state.charts).forEach((c) => c && c.destroy());
    });
  });
})();
