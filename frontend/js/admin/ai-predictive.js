(function () {
  const AI_UNAVAILABLE = 'AI analysis is temporarily unavailable. Statistical inventory insights are still available.';
  const NO_RISK = 'No significant vaccine inventory risks detected based on the available data.';
  const NO_FORECAST = 'Forecasts appear once daily AM and PM counts are recorded.';
  const COLORS = { blue: '#4274D9', navy: '#293681', green: '#16a34a', orange: '#ea580c', red: '#dc2626' };
  const charts = {};
  let lastStats = null;
  let generating = false;
  let aiState = null;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  function vials(n) {
    return n == null ? '—' : `${n} vial${Number(n) === 1 ? '' : 's'}`;
  }

  function listHtml(items, empty) {
    const rows = (items || []).map((t) => String(t || '').trim()).filter(Boolean);
    if (!rows.length) return `<p class="ai-empty">${escapeHtml(empty)}</p>`;
    return rows.map((t) => `<p>• ${escapeHtml(t)}</p>`).join('');
  }

  function textList(v) {
    const arr = Array.isArray(v) ? v : (v ? [v] : []);
    return arr
      .map((x) => (typeof x === 'string' || typeof x === 'number') ? String(x) : (x && (x.text || x.message)) || '')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'undefined' && s !== '[object Object]');
  }

  function humanizeBasis(s) {
    return String(s || '').replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g, (w) => w
      .replace(/AMPM/g, ' AM/PM ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => (/^(AM|PM|AM\/PM)$/.test(part) ? part : part.toLowerCase()))
      .join(' '));
  }

  function badge(label, cls) {
    return `<span class="ai-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  function statusBadge(status) {
    const s = String(status || '—');
    let cls = 'ok';
    if (/critical|expired|out of stock|inconsistent|depletion/i.test(s)) cls = 'crit';
    else if (/low|expir|missing|incomplete|pending/i.test(s)) cls = 'low';
    else if (/cannot|insufficient|no lots|awaiting/i.test(s)) cls = 'mute';
    return badge(s, cls);
  }

  function trendLabel(trend, preliminary) {
    const t = String(trend || '');
    const tag = preliminary ? ' (preliminary)' : '';
    if (/increas/i.test(t)) return `↗ Increasing${tag}`;
    if (/decreas/i.test(t)) return `↘ Decreasing${tag}`;
    if (/stable/i.test(t)) return `→ Stable${tag}`;
    if (/baseline/i.test(t)) return 'Baseline (1 day)';
    return 'No records';
  }

  function mkChart(id, config) {
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (!el) return;
    charts[id] = new Chart(el, config);
  }

  function filterQuery() {
    const p = new URLSearchParams();
    const from = document.getElementById('aiFrom')?.value;
    const to = document.getElementById('aiTo')?.value;
    const vaccine = document.getElementById('aiVaccine')?.value;
    const grain = document.getElementById('aiGrain')?.value;
    if (from) p.set('date_from', from);
    if (to) p.set('date_to', to);
    if (vaccine) p.set('vaccine_id', vaccine);
    if (grain) p.set('grain', grain);
    return p;
  }

  function showPane(id) {
    document.querySelectorAll('.ai-pane').forEach((el) => el.classList.toggle('active', el.id === id));
    document.querySelectorAll('.ai-tab').forEach((el) => el.classList.toggle('active', el.dataset.pane === id));
    Object.values(charts).forEach((c) => { try { c.resize(); } catch (_) { /* ignore */ } });
  }

  function notice(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = text ? `<div class="ai-notice ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
  }

  function renderUsage(d) {
    const inv = d.inventory || {};
    const dq = d.dataQuality || {};
    const am = d.amPmAnalysis || {};
    setText('uTotal', vials(inv.totalVaccinesUsed ?? 0));
    setText('uAvg', dq.recordedDays ? vials(inv.averageDailyUsage) : '—');
    setText('uDays', dq.recordedDays ?? 0);
    setText('uDaysHint', dq.firstRecordDate ? `${dq.firstRecordDate} to ${dq.lastRecordDate}` : 'No verified records yet');
    setText('uAdd', vials(inv.additionalVaccinesReceived ?? 0));
    setText('uPairs', am.completed ?? 0);
    setText('uPeriodNote', `${inv.usageDefinition || ''} Reporting period: ${d.forecast?.period || '—'}.`);

    const series = d.usageSeries || [];
    const asBars = series.length < 3;
    mkChart('chartUsage', {
      type: asBars ? 'bar' : 'line',
      data: {
        labels: series.map((t) => String(t.period).replace(/^(\d{4})-W(\d+)$/, 'Week $2, $1')),
        datasets: [{
          label: 'Vials used',
          data: series.map((t) => t.used || 0),
          borderColor: COLORS.navy,
          backgroundColor: asBars ? COLORS.navy : 'rgba(41,54,129,.12)',
          maxBarThickness: 60,
          fill: true,
          tension: 0.2,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });

    const rows = (d.forecast?.items || []).filter((r) => r.historicalUsage > 0);
    mkChart('chartUsageVaccine', {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.vaccine),
        datasets: [{ label: 'Vials used', data: rows.map((r) => r.historicalUsage), backgroundColor: COLORS.blue }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { ticks: { autoSkip: false, font: { size: 11 } } } },
      },
    });

    const overall = inv.overallTrend || {};
    if (dq.trendAvailable) {
      notice('uTrendNotice', `Overall weekly average daily usage: ${trendLabel(overall.trend)} (about ${overall.changePct}% across ${overall.periods} weeks).`, 'info');
    } else if (overall.basis === 'daily') {
      notice('uTrendNotice', `Preliminary trend comparing daily usage across ${overall.periods} recorded days (${dq.firstRecordDate} to ${dq.lastRecordDate}): ${trendLabel(overall.trend)}${overall.changePct != null ? ` (about ${overall.changePct}%)` : ''}. It becomes a reliable weekly trend after 3 weeks of records.`, 'info');
    } else if (dq.recordedDays) {
      notice('uTrendNotice', `Usage from ${dq.firstRecordDate} is the baseline. Trends appear once a second day of verified records is available.`, 'info');
    } else {
      notice('uTrendNotice', 'Trends appear once daily AM and PM counts are recorded.', 'info');
    }
    const trends = d.usageTrends || [];
    document.getElementById('usageTrendList').innerHTML = trends.length
      ? trends.map((t) => `<div class="ai-trend-row"><span>${escapeHtml(t.vaccine)}</span><strong>${escapeHtml(vials(t.historicalUsage ?? 0))} · ${escapeHtml(trendLabel(t.trend, t.preliminary && t.basis === 'daily'))}</strong></div>`).join('')
      : '<p class="ai-empty">No verified vaccine usage records for the selected filters.</p>';
  }

  function renderForecast(d) {
    const forecast = d.forecast || {};
    const items = forecast.items || [];
    const dq = d.dataQuality || {};
    const horizon = forecast.forecastDays || 30;
    notice('forecastNotice', forecast.note || NO_FORECAST, 'info');
    const cell = (r, h) => (r.forecastMethod === 'insufficient' || !r.forecasts || r.forecasts[h] == null
      ? '<span style="color:#94a3b8;">Unavailable</span>'
      : `${escapeHtml(r.forecasts[h])} <span style="color:#94a3b8;font-size:11px;">total</span>`);
    document.getElementById('forecastBody').innerHTML = items.length
      ? items.map((r) => `<tr>
          <td><strong>${escapeHtml(r.vaccine)}</strong></td>
          <td>${escapeHtml(r.historicalUsage ?? 0)}</td>
          <td>${r.recordedDays ? escapeHtml(r.averageDailyUsage) : '—'}</td>
          <td>${cell(r, 7)}</td><td>${cell(r, 30)}</td><td>${cell(r, 90)}</td>
          <td style="font-size:12px;">${escapeHtml(r.forecastMethodLabel || 'Not available')}</td>
          <td>${escapeHtml(trendLabel(r.trend, r.trendBasis === 'daily'))}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="ai-empty">No inventory data for the selected filters.</td></tr>';

    const wrap = document.getElementById('forecastChartWrap');
    const withForecast = items.filter((r) => r.forecastMethod !== 'insufficient');
    if (wrap) wrap.style.display = withForecast.length ? 'block' : 'none';
    if (withForecast.length) {
      mkChart('chartForecast', {
        type: 'bar',
        data: {
          labels: withForecast.map((r) => r.vaccine),
          datasets: [
            { label: 'Current stock', data: withForecast.map((r) => r.currentStock), backgroundColor: COLORS.blue },
            { label: `Forecast usage, next ${horizon} days (total)`, data: withForecast.map((r) => r.forecastUsage), backgroundColor: COLORS.orange },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } },
      });
    } else if (charts.chartForecast) {
      charts.chartForecast.destroy();
      delete charts.chartForecast;
    }

    const high = d.inventory?.highUsageVaccines || [];
    document.getElementById('highUsage').innerHTML = high.length
      ? high.map((h) => `<p>• <strong>${escapeHtml(h.vaccine)}</strong>: ${escapeHtml(vials(h.historicalUsage))} (${escapeHtml(h.sharePct)}% of verified usage in the reporting period)</p>`).join('')
        + ((dq.recordedDays || 0) >= (dq.requirements?.reliableForecastDays || 7) ? '' : '<p class="ai-note">Shown for reference only; with limited records this is not treated as a risk alert.</p>')
      : '<p class="ai-empty">No vaccine stands out from the others in recorded usage.</p>';

    const p = d.predictions || {};
    setText('aiTotalCases', d.cases?.totalCases ?? '—');
    setText('aiPredMonth', p.predictedNextMonth == null ? '—' : `${p.predictedNextMonth} cases`);
    setText('aiPredQuarter', p.predictedNextQuarter == null ? '—' : `${p.predictedNextQuarter} cases`);
    const demand = d.demand || {};
    setText('demandObs', demand.observation || 'No bite cases or verified vaccine usage have been recorded for the selected period yet.');
    const ds = demand.monthly || [];
    mkChart('chartDemand', {
      type: ds.length < 2 ? 'bar' : 'line',
      data: {
        labels: ds.map((m) => String(m.month).replace(/^(\d{4})-W(\d+)$/, 'Week $2, $1')),
        datasets: [
          { label: 'Bite cases', data: ds.map((m) => m.cases), borderColor: COLORS.navy, backgroundColor: ds.length < 2 ? COLORS.navy : 'rgba(41,54,129,.12)', fill: true, tension: 0.2 },
          { label: 'Vials used', data: ds.map((m) => m.vaccineUsage), borderColor: COLORS.green, backgroundColor: ds.length < 2 ? COLORS.green : 'rgba(22,163,74,.12)', fill: true, tension: 0.2 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } },
    });
  }

  function riskHtml(alerts, emptyText) {
    if (!alerts.length) return `<p class="ai-empty">${escapeHtml(emptyText || NO_RISK)}</p>`;
    const sev = { critical: 'crit', high: 'low', medium: 'info' };
    return alerts.map((a) => `<div class="risk-item">${badge(a.risk, sev[a.severity] || 'info')}
      <div class="body"><strong>${escapeHtml(a.vaccine)}</strong> — ${escapeHtml(a.detail)}</div></div>`).join('');
  }

  function renderMonitoring(d) {
    const mon = d.monitoring || {};
    setText('monStock', vials(d.inventory?.remainingInventory ?? 0));
    setText('monLow', mon.lowStockItems ?? 0);
    setText('monCrit', mon.criticalStockItems ?? 0);
    setText('monOut', mon.outOfStockItems ?? 0);
    setText('monExp', mon.expiringItems ?? 0);
    setText('monExpired', mon.expiredItems ?? 0);
    const consistencyEl = document.getElementById('monConsistency');
    const mismatches = (mon.consistency && mon.consistency.mismatches) || [];
    if (consistencyEl) {
      consistencyEl.style.display = mismatches.length ? 'block' : 'none';
      consistencyEl.textContent = mismatches.join(' ');
    }
    document.getElementById('monRisk').innerHTML = riskHtml(d.backendRiskAlerts || [], d.noRiskMessage);
    const rows = mon.rows || [];
    document.getElementById('monBody').innerHTML = rows.length
      ? rows.map((r) => {
        const calc = r.stockCalculation;
        const title = calc
          ? `Opening ${calc.openingStock} + Additional ${calc.additionalStock} − Used ${calc.vaccinesUsed} + Corrections ${calc.corrections} = ${r.currentStock}. Period receipts are not added again.`
          : 'Current stock is the usable quantity on hand.';
        return `<tr>
          <td><strong>${escapeHtml(r.vaccine)}</strong></td>
          <td title="${escapeHtml(title)}">${escapeHtml(r.currentStock)} vials</td>
          <td>${escapeHtml(r.lowThreshold ?? '—')} / ${escapeHtml(r.criticalThreshold ?? '—')}</td>
          <td title="Verified receipts in the selected period. Already included in current stock when they were received.">${escapeHtml(r.additionalReceived ?? 0)}</td>
          <td>${statusBadge(r.inventoryStatus)}</td>
          <td title="${escapeHtml(r.sufficiencyBasis || '')}">${statusBadge(r.stockSufficiency)}</td>
          <td style="font-size:12px;">${escapeHtml(r.expirationStatus || '—')}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="7" class="ai-empty">No inventory lots for the selected filters.</td></tr>';
    mkChart('chartStock', {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.vaccine),
        datasets: [{
          label: 'Current usable stock',
          data: rows.map((r) => Number(r.currentStock) || 0),
          backgroundColor: rows.map((r) => {
            if (r.inventoryStatus === 'Out of Stock' || r.inventoryStatus === 'Critical') return COLORS.red;
            if (r.inventoryStatus === 'Low Stock') return COLORS.orange;
            return COLORS.green;
          }),
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }

  function renderAmPm(d) {
    const am = d.amPmAnalysis || {};
    const shifts = d.shifts || {};
    if (shifts.note) setText('shiftNote', shifts.note);
    setText('shiftDone', am.completed ?? 0);
    const missAm = Number(am.missingAm) || 0;
    const missPm = Number(am.missingPm) || 0;
    const missTotal = am.missingTotal ?? missAm + missPm;
    const missEl = document.getElementById('shiftMissing');
    if (missEl) {
      missEl.innerHTML = `${escapeHtml(missTotal)}<span class="unit">${missTotal === 1 ? 'record' : 'records'}</span>`;
    }
    setText('shiftMissSplit', `AM: ${missAm} | PM: ${missPm}`);
    const awaiting = [
      am.awaitingAm ? `${am.awaitingAm} AM` : '',
      am.awaitingPm ? `${am.awaitingPm} PM` : '',
    ].filter(Boolean);
    setText('shiftAwaiting', awaiting.length ? `Awaiting (shift still open): ${awaiting.join(', ')}` : '');
    setText('shiftUsed', vials(d.inventory?.totalVaccinesUsed ?? 0));
    setText('shiftAdd', vials(d.inventory?.additionalVaccinesReceived ?? 0));
    const rows = am.rows || [];
    const scope = am.operatingDays
      ? `${am.expectedVaccineDays} vaccine-day(s) checked across ${am.operatingDays} clinic day(s). A count is Missing once its shift has ended or been closed.`
      : '';
    setText('amPmMeta', [
      rows.length && am.totalRows > rows.length ? `Showing the latest ${rows.length} of ${am.totalRows} vaccine-day records.` : '',
      scope,
      'Vials Used = verified AM count + PM additional stock − PM count. AM additional stock is already inside the AM count.',
    ].filter(Boolean).join(' '));
    document.getElementById('amPmBody').innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${escapeHtml(r.date)}</td>
          <td>${escapeHtml(r.vaccine)}</td>
          <td>${r.am == null ? '—' : escapeHtml(r.am)}</td>
          <td>${escapeHtml(r.additional ?? 0)}</td>
          <td>${r.pm == null ? '—' : escapeHtml(r.pm)}</td>
          <td>${r.used == null ? '—' : escapeHtml(r.used)}</td>
          <td>${statusBadge(r.status)}</td>
          <td style="font-size:12px;">${escapeHtml(r.amRecordedBy || '—')} / ${escapeHtml(r.pmRecordedBy || '—')}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="ai-empty">No AM/PM records in this period.</td></tr>';
  }

  function renderStats(d) {
    lastStats = d;
    renderUsage(d);
    renderForecast(d);
    renderMonitoring(d);
    renderAmPm(d);
  }

  function renderAi(d) {
    const statistical = d.source === 'fallback';
    const sourceBadges = statistical
      ? badge('Statistical Fallback Active', 'low') + (aiState === 'failed' ? badge('AI Analysis Unavailable', 'crit') : '')
      : badge(`AI Generated${d.aiModel ? ` · Groq ${d.aiModel}` : ''}`, 'ok');
    document.getElementById('aiSourceBadges').innerHTML = sourceBadges;
    setText('insightTitle', statistical ? 'Statistical Insights (not AI-generated)' : 'AI Insights');
    setText('recTitle', statistical ? 'Statistical Recommendations (not AI-generated)' : 'AI Recommendations');
    const insights = [...new Set([...textList(d.insights), ...textList(d.inventoryInsights)])];
    document.getElementById('insightBody').innerHTML = listHtml(insights, 'No insights supported by the available data.');

    const details = Array.isArray(d.recommendationDetails) ? d.recommendationDetails : [];
    document.getElementById('recBody').innerHTML = details.length
      ? details.map((r) => `<p>• ${escapeHtml(r.text)}<span class="basis">Basis: ${escapeHtml(humanizeBasis(r.basis))}</span></p>`).join('')
      : listHtml(textList(d.recommendations), 'No recommendations supported by the available data.');

    const trend = textList(d.trendExplanation);
    textList(d.forecastInterpretation).forEach((t) => { if (!trend.includes(t)) trend.push(t); });
    document.getElementById('trendBody').innerHTML = listHtml(trend, NO_FORECAST);

    const backend = d.backendRiskAlerts || [];
    const aiRisk = textList(d.riskAlerts || d.riskAreas);
    document.getElementById('riskBody').innerHTML = !backend.length
      ? `<p class="ai-empty">${escapeHtml(d.noRiskMessage || NO_RISK)}</p>`
      : (aiRisk.length ? listHtml(aiRisk, NO_RISK) : riskHtml(backend));

    const limits = [...new Set([...textList(d.limitations), ...textList(d.dataLimitations)])];
    if (d.removedStatements) limits.push(`${d.removedStatements} AI statement(s) were removed because they were not supported by the calculated data.`);
    document.getElementById('limitBody').innerHTML = listHtml(limits, 'No data limitations reported.');

    const when = d.lastUpdated || d.generatedAt;
    setText('aiLastUpdated', `Last Updated: ${fmtDate(when)}`);
    setText('aiPageStatus', statistical
      ? `AI was not used · Statistical insights shown · ${fmtDate(when)}`
      : `AI Analysis Generated${d.aiModel ? ` (Groq · ${d.aiModel})` : ''} · Last Updated: ${fmtDate(when)}`);
    document.getElementById('aiPageStatus').style.display = 'block';
    document.getElementById('aiEmpty').style.display = 'none';
    document.getElementById('aiResult').style.display = 'block';
  }

  async function loadStats() {
    const from = document.getElementById('aiFrom')?.value;
    const to = document.getElementById('aiTo')?.value;
    if (from && to && to < from) {
      if (window.RemisNotify) RemisNotify.toast('The end date cannot be earlier than the start date.', 'warning');
      return;
    }
    const qs = filterQuery().toString();
    const r = await fetch('/api/admin/analytics/ai-insights' + (qs ? ('?' + qs) : ''));
    if (r.status === 401) { window.location.href = '/shared/login.html'; return; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.message || 'Failed to load analytics');
    document.getElementById('aiPageError').style.display = 'none';
    renderStats(j.data || {});
  }

  async function generateAIAnalysis() {
    if (generating) return;
    const btn = document.getElementById('btnGenerateAI');
    const loading = document.getElementById('aiLoading');
    const error = document.getElementById('aiError');
    const empty = document.getElementById('aiEmpty');
    const result = document.getElementById('aiResult');
    generating = true;
    btn.disabled = true;
    loading.style.display = 'flex';
    error.style.display = 'none';
    empty.style.display = 'none';
    result.style.display = 'none';
    try {
      const p = filterQuery();
      p.set('interpret', '1');
      const r = await fetch('/api/admin/analytics/ai-insights?' + p.toString());
      if (r.status === 401) { window.location.href = '/shared/login.html'; return; }
      const j = await r.json().catch(() => ({}));
      const d = j.data || null;
      if (j.aiAvailable && j.success !== false && d) {
        aiState = 'ok';
        renderStats(d);
        renderAi(d);
      } else {
        aiState = 'failed';
        error.textContent = j.message || AI_UNAVAILABLE;
        error.style.display = 'block';
        if (d) {
          renderStats(d);
          renderAi(d);
        } else {
          empty.style.display = 'block';
        }
      }
    } catch (err) {
      console.error(err);
      aiState = 'failed';
      error.textContent = AI_UNAVAILABLE;
      error.style.display = 'block';
      empty.style.display = 'block';
    } finally {
      generating = false;
      btn.disabled = false;
      loading.style.display = 'none';
    }
  }

  async function loadVaccines() {
    const sel = document.getElementById('aiVaccine');
    if (!sel) return;
    try {
      const br = await fetch('/api/inventory/brands?include_inactive=1');
      const bj = await br.json();
      sel.innerHTML = '<option value="">All vaccines</option>' + (bj.data || []).map((v) =>
        `<option value="${escapeHtml(v.vaccine_id)}">${escapeHtml(v.name || v.sheet_label)}</option>`).join('');
    } catch (e) {
      console.warn(e);
    }
  }

  function reloadStats() {
    loadStats().catch((err) => {
      console.error(err);
      document.getElementById('aiPageError').style.display = 'block';
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    document.querySelectorAll('.ai-tab').forEach((btn) => {
      btn.addEventListener('click', () => showPane(btn.dataset.pane));
    });
    document.getElementById('btnGenerateAI').addEventListener('click', generateAIAnalysis);
    document.getElementById('btnApplyStats')?.addEventListener('click', reloadStats);
    document.getElementById('btnResetStats')?.addEventListener('click', () => {
      ['aiFrom', 'aiTo', 'aiVaccine'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
      const g = document.getElementById('aiGrain'); if (g) g.value = 'day';
      reloadStats();
    });
    await loadVaccines();
    reloadStats();
    
    /* Check for hash in URL and show corresponding pane */
    if (window.location.hash) {
      const paneId = window.location.hash.substring(1);
      if (document.getElementById(paneId)) {
        showPane(paneId);
      }
    }
  });
})();
