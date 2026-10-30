/**
 * Analytics dashboard — charts, filters, and live DB data.
 */
(function () {
  'use strict';

  const CHART_REG = {};
  const C = {
    BLUE: '#4274D9', DBLUE: '#293681', TEAL: '#95CCDD',
    GREEN: '#22c55e', AMBER: '#f59e0b', RED: '#ef4444',
    GRAY: '#94a3b8',
    RISK: { None: '#94a3b8', Low: '#22c55e', Medium: '#eab308', High: '#f97316', Critical: '#ef4444' },
    PAL: ['#4274D9', '#293681', '#95CCDD', '#22c55e', '#f59e0b', '#ef4444', '#94a3b8', '#a855f7'],
  };
  const QUARTER_LABELS = { 1: '1st Quarter', 2: '2nd Quarter', 3: '3rd Quarter', 4: '4th Quarter' };
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let loadTimer = null;

  function destroyChart(id) {
    if (CHART_REG[id]) {
      CHART_REG[id].destroy();
      delete CHART_REG[id];
    }
  }

  function chartOpts(extra = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { size: 10 } } } },
      ...extra,
    };
  }

  function showEmpty(canvasId, msg) {
    destroyChart(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const wrap = canvas.parentElement;
    let el = wrap.querySelector('.an-chart-empty');
    if (!el) {
      el = document.createElement('div');
      el.className = 'an-chart-empty';
      wrap.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'flex';
    canvas.style.display = 'none';
  }

  function hideEmpty(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.style.display = 'block';
    const el = canvas.parentElement.querySelector('.an-chart-empty');
    if (el) el.style.display = 'none';
  }

  function localIso(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function quarterBounds(q, y) {
    const qi = parseInt(q, 10);
    const yi = parseInt(y, 10);
    const sm = (qi - 1) * 3 + 1;
    const em = qi * 3;
    return {
      from: `${yi}-${String(sm).padStart(2, '0')}-01`,
      to: localIso(new Date(yi, em, 0)),
    };
  }

  function monthBounds(m, y) {
    const mi = parseInt(m, 10);
    const yi = parseInt(y, 10);
    return {
      from: `${yi}-${String(mi).padStart(2, '0')}-01`,
      to: localIso(new Date(yi, mi, 0)),
    };
  }

  function setDefaultDateRange(q, y) {
    const bounds = quarterBounds(q, y);
    document.getElementById('fDateFrom').value = bounds.from;
    document.getElementById('fDateTo').value = bounds.to;
  }

  function setMonthDateRange(m, y) {
    const mi = parseInt(m, 10);
    if (!mi) return;
    const bounds = monthBounds(m, y);
    document.getElementById('fDateFrom').value = bounds.from;
    document.getElementById('fDateTo').value = bounds.to;
  }

  function buildParams() {
    const p = new URLSearchParams();
    const y = document.getElementById('fYear').value;
    const q = document.getElementById('fQuarter').value;
    const m = document.getElementById('fMonth').value;
    const d1 = document.getElementById('fDateFrom').value;
    const d2 = document.getElementById('fDateTo').value;
    const animal = document.getElementById('fAnimal').value;
    const barangay = document.getElementById('fBarangay').value;
    const risk = document.getElementById('fRisk').value;

    if (y) p.append('year', y);
    if (q) p.append('quarter', q);
    if (m) p.append('month', m);
    if (d1) p.append('dateFrom', d1);
    if (d2) p.append('dateTo', d2);
    if (animal && animal !== 'all') p.append('animalType', animal);
    if (barangay && barangay !== 'all') p.append('barangay', barangay);
    if (risk && risk !== 'all') p.append('riskLevel', risk);
    return p.toString();
  }

  function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadAnalytics, 280);
  }

  async function loadAnalytics() {
    const loading = document.getElementById('anLoading');
    if (loading) loading.style.display = 'flex';

    try {
      const res = await fetch('/api/analytics/full?' + buildParams());
      const json = await res.json();
      if (!json.success) {
        showAlert(json.message || 'Analytics could not be updated for these filters.', 'error');
        return;
      }
      const d = json.data;

      if (d.barangayList?.length) populateBarangays(d.barangayList);

      updateHeader();
      updateCards(d.summary);
      renderAllCharts(d, d.filterMeta);
      updateVaccSchedule(d.summary);
      renderAI(d);

      document.getElementById('anGenDate').textContent =
        'Updated: ' + new Date().toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit',
        });
    } catch (err) {
      console.error('Analytics error:', err);
      showAlert('Analytics could not be updated for these filters.', 'error');
    } finally {
      if (loading) loading.style.display = 'none';
    }
  }

  function populateBarangays(list) {
    const sel = document.getElementById('fBarangay');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="all">All Barangays</option>';
    list.forEach((b) => {
      const o = document.createElement('option');
      o.value = b;
      o.textContent = b;
      sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  }

  function updateHeader() {
    const q = document.getElementById('fQuarter').value;
    const y = document.getElementById('fYear').value;
    const m = document.getElementById('fMonth').value;
    const d1 = document.getElementById('fDateFrom').value;
    const d2 = document.getElementById('fDateTo').value;
    const expected = m ? monthBounds(m, y) : quarterBounds(q, y);
    const customDates = (d1 || d2) && (d1 !== expected.from || d2 !== expected.to);
    let lbl = QUARTER_LABELS[q] || 'All Quarters';
    if (customDates) lbl = `${d1 || '…'} to ${d2 || '…'}`;
    else if (m) lbl = MONTH_NAMES[parseInt(m, 10) - 1] || `Month ${m}`;
    document.getElementById('anQuarterLbl').textContent = `${lbl}, ${y}`;
  }

  function updateCards(s) {
    const total = Number(s.totalBites) || 0;
    const pct = (v) => (total > 0 ? ` (${Math.round((v / total) * 100)}%)` : ' (0%)');

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val ?? '—';
    };

    set('sc-total', s.totalPatients);
    set('sc-bites', s.totalBites);
    set('sc-dog', s.dogBites);
    set('sc-cat', s.catBites);
    set('sc-other', s.otherBites);
    set('sc-male', s.maleCount);
    set('sc-female', s.femaleCount);
    set('sc-age-lt15', s.ageLt15);
    set('sc-age-gte15', s.ageGte15);
    set('sc-vcomp', s.vaccCompleted);
    set('sc-vcomp-pct', pct(s.vaccCompleted));
    set('sc-vongoing', s.vaccOngoing);
    set('sc-vongoing-pct', pct(s.vaccOngoing));
    set('sc-vover', s.vaccOverdue);
    set('sc-vover-pct', pct(s.vaccOverdue));
    set('sc-affected', s.affectedBarangays);
    set('sc-risk', s.overallRisk);
  }

  function updateVaccSchedule(s) {
    const total = Number(s.totalBites) || 0;
    const pct = (v) => (total > 0 ? ` (${Math.round((v / total) * 100)}%)` : ' (0%)');
    document.getElementById('vs-today').textContent = s.dueToday ?? 0;
    document.getElementById('vs-week').textContent = s.dueThisWeek ?? 0;
    document.getElementById('vs-comp').textContent = `${s.vaccCompleted ?? 0}${pct(s.vaccCompleted)}`;
    document.getElementById('vs-over').textContent = `${s.vaccOverdue ?? 0}${pct(s.vaccOverdue)}`;
  }

  function renderAI(d) {
    const s = d.summary;
    const top = d.barangayCases?.[0];
    const topCat = (d.categoryData || []).reduce(
      (a, b) => (a.count > b.count ? a : b),
      { category: 'N/A', count: 0 }
    );
    const total = Number(s.totalBites) || 0;
    const vaccPct = total > 0 ? Math.round((s.vaccCompleted / total) * 100) : 0;

    const qRows = d.quarterlyData || [];
    const curQ = parseInt(document.getElementById('fQuarter').value, 10);
    const curQC = qRows.find((r) => Number(r.quarter) === curQ)?.count || 0;
    const prevQC = qRows.find((r) => Number(r.quarter) === curQ - 1)?.count || 0;

    const items = [];

    if (total === 0) {
      items.push({ color: 'blue', icon: 'fa-circle-info', text: 'No patient records match the current filters.' });
    } else {
      if (top) {
        items.push({
          color: 'red', icon: 'fa-map-location-dot',
          text: `<strong>${top.barangay}</strong> is the top affected barangay with ${top.case_count} case(s) (${top.risk_level || '—'} risk).`,
        });
      }
      if (topCat?.category !== 'N/A') {
        items.push({
          color: 'amber', icon: 'fa-layer-group',
          text: `Category ${topCat.category} has the most cases (${topCat.count}).`,
        });
      }
      const animal = s.dogBites >= s.catBites && s.dogBites >= s.otherBites
        ? 'Dog' : s.catBites >= s.otherBites ? 'Cat' : 'Other';
      const animalPct = total > 0
        ? ((Math.max(s.dogBites, s.catBites, s.otherBites) / total) * 100).toFixed(1)
        : '0.0';
      items.push({
        color: 'amber', icon: 'fa-paw',
        text: `${animal} bites account for ${animalPct}% of filtered cases.`,
      });
      const sexTotal = Number(s.maleCount) + Number(s.femaleCount);
      if (sexTotal > 0) {
        items.push({
          color: 'blue', icon: 'fa-venus-mars',
          text: `Sex of cases: ${Number(s.maleCount) || 0} male and ${Number(s.femaleCount) || 0} female.`,
        });
      }
      const ageTotal = Number(s.ageLt15) + Number(s.ageGte15);
      if (ageTotal > 0) {
        items.push({
          color: 'blue', icon: 'fa-user-group',
          text: `Age of cases: ${Number(s.ageLt15) || 0} under 15 years and ${Number(s.ageGte15) || 0} aged 15 years or older.`,
        });
      }
      items.push({
        color: vaccPct >= 70 ? 'green' : 'amber',
        icon: vaccPct >= 70 ? 'fa-circle-check' : 'fa-hourglass-half',
        text: `Vaccination completion rate is ${vaccPct}% for the selected period.`,
      });
      if (prevQC > 0) {
        const diff = curQC - prevQC;
        const dir = diff > 0 ? `increased by ${diff}` : diff < 0 ? `decreased by ${Math.abs(diff)}` : 'remained stable';
        items.push({
          color: diff > 0 ? 'red' : 'green',
          icon: diff > 0 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down',
          text: `Quarterly cases ${dir} (${prevQC} → ${curQC}).`,
        });
      }
      items.push({
        color: 'blue', icon: 'fa-shield-halved',
        text: `Overall risk level for this period: <strong>${s.overallRisk || 'LOW'}</strong>.`,
      });
    }

    document.getElementById('aiList').innerHTML = items.map((i) =>
      `<div class="an-ai-item ${i.color}"><span class="an-ai-icon"><i class="fa-solid ${i.icon}"></i></span><span>${i.text}</span></div>`
    ).join('');
  }

  function renderAllCharts(d, meta) {
    renderMonthly(d.monthlyTrend, meta && meta.chartYear);
    renderBarangay(d.barangayCases);
    renderAnimal(d.summary);
    renderCategory(d.categoryData);
    renderAge(d.summary);
    renderGender(d.summary);
    renderRisk(d.riskDistribution);
    renderBrand(d.brandData);
    renderQuarterly(d.quarterlyData);
    renderYearly(d.yearlyData);
  }

  function renderMonthly(rows, chartYear) {
    const id = 'monthly';
    const y = parseInt(chartYear, 10) || parseInt(document.getElementById('fYear').value, 10) || new Date().getFullYear();
    const data = MONTH_NAMES.map((_, i) => {
      const key = `${y}-${String(i + 1).padStart(2, '0')}`;
      return (rows || []).find((r) => r.month === key)?.count || 0;
    });
    if (!data.some((v) => v > 0)) {
      showEmpty(id, 'No monthly data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartMonthly'), {
      type: 'line',
      data: {
        labels: MONTH_NAMES,
        datasets: [{
          label: 'Cases', data,
          borderColor: C.BLUE, backgroundColor: 'rgba(66,116,217,0.10)',
          fill: true, tension: 0.3, pointRadius: 3,
        }],
      },
      options: chartOpts({ scales: { y: { beginAtZero: true } } }),
    });
  }

  function renderBarangay(rows) {
    const id = 'barangay';
    const top10 = [...(rows || [])].sort((a, b) => b.case_count - a.case_count).slice(0, 10);
    if (!top10.length) {
      showEmpty(id, 'No barangay data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartBarangay'), {
      type: 'bar',
      data: {
        labels: top10.map((r) => r.barangay),
        datasets: [{ data: top10.map((r) => r.case_count), backgroundColor: C.BLUE, borderRadius: 4 }],
      },
      options: chartOpts({ indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }),
    });
  }

  function renderAnimal(s) {
    const id = 'animal';
    const total = (s.dogBites + s.catBites + s.otherBites) || 0;
    if (!total) {
      showEmpty(id, 'No animal bite data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartAnimal'), {
      type: 'pie',
      data: {
        labels: ['Dog', 'Cat', 'Other'],
        datasets: [{ data: [s.dogBites, s.catBites, s.otherBites], backgroundColor: [C.BLUE, C.GREEN, C.AMBER] }],
      },
      options: chartOpts({ plugins: { legend: { position: 'right' } } }),
    });
  }

  function renderCategory(rows) {
    const id = 'category';
    const cats = ['1', '2', '3'];
    const data = cats.map((c) => (rows || []).find((r) => String(r.category) === c)?.count || 0);
    if (!data.some((v) => v > 0)) {
      showEmpty(id, 'No category data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartCategory'), {
      type: 'bar',
      data: {
        labels: ['Category I', 'Category II', 'Category III'],
        datasets: [{ data, backgroundColor: [C.BLUE, C.GREEN, C.AMBER], borderRadius: 5 }],
      },
      options: chartOpts({ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }),
    });
  }

  function renderAge(s) {
    const id = 'age';
    const lt15 = Number(s && s.ageLt15) || 0;
    const gte15 = Number(s && s.ageGte15) || 0;
    if (lt15 + gte15 === 0) {
      showEmpty(id, 'No age data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartAge'), {
      type: 'bar',
      data: {
        labels: ['< 15 years', '≥ 15 years'],
        datasets: [{ data: [lt15, gte15], backgroundColor: [C.BLUE, C.GREEN], borderRadius: 5 }],
      },
      options: chartOpts({ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }),
    });
  }

  function renderGender(s) {
    const id = 'gender';
    const total = s.maleCount + s.femaleCount;
    if (!total) {
      showEmpty(id, 'No gender data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartGender'), {
      type: 'doughnut',
      data: {
        labels: ['Male', 'Female'],
        datasets: [{ data: [s.maleCount, s.femaleCount], backgroundColor: [C.BLUE, C.GREEN] }],
      },
      options: chartOpts({ plugins: { legend: { position: 'right' } } }),
    });
  }

  function renderRisk(rows) {
    const id = 'risk';
    const order = ['None', 'Low', 'Medium', 'High', 'Critical'];
    const map = Object.fromEntries((rows || []).map((r) => [r.level, r.count]));
    const data = order.map((l) => map[l] || 0);
    if (!data.some((v) => v > 0)) {
      showEmpty(id, 'No risk distribution data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartRisk'), {
      type: 'bar',
      data: {
        labels: order,
        datasets: [{
          label: 'Barangays',
          data,
          backgroundColor: order.map((l) => C.RISK[l]),
          borderRadius: 5,
        }],
      },
      options: chartOpts({ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }),
    });
  }

  function renderBrand(rows) {
    const id = 'brand';
    // Use whatever brands are actually in the data — do not hardcode the list.
    const filtered = (rows || []).filter((r) => r.brand_name && Number(r.count) > 0);
    if (!filtered.length) {
      showEmpty(id, 'No vaccine brand data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    // Assign a colour palette that cycles if more than 2 brands exist.
    const palette = [C.BLUE, C.TEAL, C.AMBER, C.DBLUE, C.GREEN, C.RED];
    CHART_REG[id] = new Chart(document.getElementById('chartBrand'), {
      type: 'bar',
      data: {
        labels: filtered.map((r) => r.brand_name),
        datasets: [{
          data: filtered.map((r) => Number(r.count)),
          backgroundColor: filtered.map((_, i) => palette[i % palette.length]),
          borderRadius: 6,
        }],
      },
      options: chartOpts({ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }),
    });
  }

  function renderQuarterly(rows) {
    const id = 'quarterly';
    const data = [1, 2, 3, 4].map((q) => {
      const row = (rows || []).find((r) => Number(r.quarter) === q);
      return row ? Number(row.count) || 0 : 0;
    });
    if (!data.some((v) => v > 0)) {
      showEmpty(id, 'No quarterly data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartQuarterly'), {
      type: 'bar',
      data: {
        labels: ['Q1', 'Q2', 'Q3', 'Q4'],
        datasets: [{ data, backgroundColor: [C.BLUE, C.TEAL, C.AMBER, C.DBLUE], borderRadius: 5 }],
      },
      options: chartOpts({ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }),
    });
  }

  function renderYearly(rows) {
    const id = 'yearly';
    if (!rows?.length) {
      showEmpty(id, 'No yearly data for selected filters.');
      return;
    }
    hideEmpty(id);
    destroyChart(id);
    CHART_REG[id] = new Chart(document.getElementById('chartYearly'), {
      type: 'line',
      data: {
        labels: rows.map((r) => r.yr),
        datasets: [{
          label: 'Cases', data: rows.map((r) => r.count),
          borderColor: C.BLUE, backgroundColor: 'rgba(66,116,217,0.10)',
          fill: true, tension: 0.3,
        }],
      },
      options: chartOpts({ scales: { y: { beginAtZero: true } } }),
    });
  }

  function bindFilters() {
    const ids = ['fYear', 'fQuarter', 'fMonth', 'fDateFrom', 'fDateTo', 'fAnimal', 'fBarangay', 'fRisk'];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', onFilterChange);
    });
  }

  function onFilterChange(e) {
    const id = e?.target?.id;
    const y = document.getElementById('fYear').value;
    if (id === 'fQuarter') {
      document.getElementById('fMonth').value = '';
      setDefaultDateRange(document.getElementById('fQuarter').value, y);
    }
    if (id === 'fMonth') {
      const m = document.getElementById('fMonth').value;
      if (m) setMonthDateRange(m, y);
      else setDefaultDateRange(document.getElementById('fQuarter').value, y);
    }
    if (id === 'fYear') {
      const m = document.getElementById('fMonth').value;
      if (m) setMonthDateRange(m, y);
      else setDefaultDateRange(document.getElementById('fQuarter').value, y);
    }
    scheduleLoad();
  }

  // ── AI Predictive Analytics Functions ─────────────────────────────────────

  const AI_UNAVAILABLE = 'AI analysis is temporarily unavailable. Statistical insights are still available.';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function trendLabel(t) {
    const v = String(t || 'Stable');
    if (/increas/i.test(v)) return 'Increasing ↑';
    if (/decreas/i.test(v)) return 'Decreasing ↓';
    return 'Stable →';
  }

  function textList(v) {
    const arr = Array.isArray(v) ? v : (v ? [v] : []);
    return arr
      .map((x) => (typeof x === 'string' || typeof x === 'number') ? String(x) : (x && (x.text || x.message)) || '')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'undefined' && s !== '[object Object]');
  }

  function toggleAiSection(wrapId, bodyId, lines, color) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    if (!lines.length) { wrap.style.display = 'none'; return; }
    const body = document.getElementById(bodyId);
    if (color) renderAiLines(body, lines, color);
    else body.textContent = lines.join(' ');
    wrap.style.display = 'block';
  }

  let aiGenerating = false;

  function renderAiLines(el, lines, color) {
    if (!el) return;
    const list = textList(lines);
    if (!list.length) {
      el.innerHTML = '<p style="color:#94a3b8;font-size:12px;text-align:center;padding:8px;">No items for this period.</p>';
      return;
    }
    el.innerHTML = list.map((text) =>
      `<div class="an-ai-item ${color}"><span class="an-ai-icon"><i class="fa-solid fa-circle-check"></i></span><span>${escapeHtml(text)}</span></div>`
    ).join('');
  }

  async function generateAIAnalysis() {
    const btn = document.getElementById('btnGenerateAI');
    const loading = document.getElementById('aiPredictLoading');
    const error = document.getElementById('aiPredictError');
    const errorText = document.getElementById('aiPredictErrorText');
    const warn = document.getElementById('aiPredictWarn');
    const warnText = document.getElementById('aiPredictWarnText');
    const grid = document.getElementById('aiPredictionsGrid');
    const insights = document.getElementById('aiInsightsCard');
    const status = document.getElementById('aiPredictStatus');

    if (aiGenerating) return;
    aiGenerating = true;
    btn.disabled = true;
    loading.style.display = 'flex';
    error.style.display = 'none';
    if (warn) warn.style.display = 'none';
    if (status) status.style.display = 'none';
    grid.style.display = 'none';
    insights.style.display = 'none';

    try {
      const res = await fetch('/api/analytics/ai-insights?interpret=1&' + buildParams());
      const payload = await res.json().catch(() => ({}));
      const d = payload.data || {};
      const p = d.predictions || {};
      document.getElementById('aiPredNextMonth').textContent = `${p.predictedNextMonth ?? '—'} Cases`;
      document.getElementById('aiPredNextQuarter').textContent = `${p.predictedNextQuarter ?? '—'} Cases`;
      document.getElementById('aiPredBarangay').textContent = p.highestRiskBarangay || '—';
      document.getElementById('aiPredTrend').textContent = trendLabel(p.trend);
      grid.style.display = 'grid';

      const insightLines = textList(d.insights);
      const recLines = textList(d.recommendations);
      const trendLines = textList(d.trendExplanation);
      textList(d.forecastInterpretation).forEach((t) => { if (!trendLines.includes(t)) trendLines.push(t); });
      const aiOk = payload.aiAvailable && payload.success !== false && (insightLines.length || recLines.length);

      if (aiOk) {
        renderAiLines(document.getElementById('aiInsightsText'), insightLines, 'blue');
        renderAiLines(document.getElementById('aiRecsText'), recLines, 'green');
        toggleAiSection('aiTrendWrap', 'aiTrendText', trendLines, 'blue');
        toggleAiSection('aiRiskWrap', 'aiRiskText', textList(d.riskAreas), 'amber');
        toggleAiSection('aiLimitWrap', 'aiLimitText', textList(d.limitations));
        const when = d.lastUpdated || d.generatedAt;
        const whenLabel = when ? new Date(when).toLocaleString() : new Date().toLocaleString();
        const lastEl = document.getElementById('aiLastUpdated');
        if (lastEl) lastEl.textContent = `Last Updated: ${whenLabel}`;
        if (status) {
          status.textContent = `AI Analysis Generated${d.aiModel ? ` (Groq · ${d.aiModel})` : ''} · Last Updated: ${whenLabel}`;
          status.style.display = 'block';
        }
        insights.style.display = 'block';
      } else {
        let msg = payload.message || AI_UNAVAILABLE;
        if (payload.success !== false && !insightLines.length && !recLines.length) {
          msg = 'The AI returned no usable insights for this period. Statistical insights are still available.';
        }
        errorText.textContent = msg;
        error.style.display = 'block';
        insights.style.display = 'none';
      }
    } catch (err) {
      console.error('AI Analysis error:', err);
      errorText.textContent = AI_UNAVAILABLE;
      error.style.display = 'block';
    } finally {
      aiGenerating = false;
      btn.disabled = false;
      loading.style.display = 'none';
    }
  }

  // ── Initialize ────────────────────────────────────────────────────────────

  async function init() {
    const auth = await checkAuth();

    const ySel = document.getElementById('fYear');
    const now = new Date();
    const curY = now.getFullYear();
    for (let y = curY; y >= curY - 5; y--) {
      const o = document.createElement('option');
      o.value = y;
      o.textContent = y;
      ySel.appendChild(o);
    }
    ySel.value = curY;
    document.getElementById('fQuarter').value = String(Math.ceil((now.getMonth() + 1) / 3));
    // Do NOT pre-fill fDateFrom / fDateTo on load — leave them blank so buildParams()
    // sends year+quarter instead. setDefaultDateRange is called only when the user
    // explicitly changes the quarter or month filter via onFilterChange.

    bindFilters();
    await loadAnalytics();

    // Bind AI button
    const aiBtn = document.getElementById('btnGenerateAI');
    if (aiBtn) {
      aiBtn.addEventListener('click', generateAIAnalysis);
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  window.loadAnalytics = loadAnalytics;
})();
