/**
 * Geographic Case Map – Gingoog City GIS Engine
 * Polygon geometry from gingoog-barangays.geojson ONLY.
 * Case statistics from /api/analytics/map-data ONLY.
 */
(function (global) {
  'use strict';

  const GEOJSON_URL = '/data/gingoog-barangays.geojson';
  const BORDER_COLOR = '#2563EB';
  const BORDER_WEIGHT = 1.8;
  const BORDER_HOVER = 3;

  const RISK_COLORS = {
    None: '#94a3b8',
    Low: '#22c55e',
    Medium: '#eab308',
    High: '#f97316',
    Critical: '#ef4444',
  };

  let map = null;
  let polygonLayer = null;
  let markerLayer = null;
  let labelLayer = null;

  let geoData = null;
  let geoCache = null;
  let featureIndex = new Map();
  let caseData = new Map();
  let summaryData = {};
  let barangayCases = [];
  let unmatchedRows = [];  // DB rows with no matching GeoJSON polygon (e.g. "Others")

  let layerOn = { polygons: true, markers: true, labels: false };
  let cityBounds = null;

  // ── Name normalisation ───────────────────────────────────────────────────
  function norm(s) {
    return (s || '')
      .trim()
      .toLowerCase()
      .replace(/\s*\(pob\.?\)\s*/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9]/g, '');
  }

  function displayName(raw) {
    return (raw || '').replace(/\s*\(Pob\.?\)\s*/gi, '').trim();
  }

  function getFeatureName(feat) {
    const p = feat.properties || {};
    return p.barangay || p.name || p.NAME || p.ADM4_EN || p.BARANGAY || '';
  }

  // ── Risk helpers ─────────────────────────────────────────────────────────
  function riskLevel(n) {
    if (!n || n === 0) return 'None';
    if (n >= 20) return 'Critical';
    if (n >= 10) return 'High';
    if (n >= 5) return 'Medium';
    return 'Low';
  }

  function riskColor(n) {
    return RISK_COLORS[riskLevel(n)] || RISK_COLORS.None;
  }

  function riskBadge(level) {
    const m = {
      None: 'background:#f1f5f9;color:#64748b;',
      Low: 'background:#dcfce7;color:#15803d;',
      Medium: 'background:#fef9c3;color:#854d0e;',
      High: 'background:#ffedd5;color:#c2410c;',
      Critical: 'background:#fee2e2;color:#b91c1c;',
    };
    return m[level] || m.None;
  }

  // ── Polygon centroid (area-weighted) ─────────────────────────────────────
  function ringCentroid(ring) {
    let area = 0;
    let cx = 0;
    let cy = 0;
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const f = x1 * y2 - x2 * y1;
      area += f;
      cx += (x1 + x2) * f;
      cy += (y1 + y2) * f;
    }
    area *= 0.5;
    if (Math.abs(area) < 1e-14) return null;
    return [cx / (6 * area), cy / (6 * area)];
  }

  function polygonCentroid(coords) {
    let totalArea = 0;
    let sumLng = 0;
    let sumLat = 0;

    for (const ring of coords) {
      const c = ringCentroid(ring);
      if (!c) continue;
      let area = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      area = Math.abs(area * 0.5);
      totalArea += area;
      sumLng += c[0] * area;
      sumLat += c[1] * area;
    }

    if (totalArea < 1e-14) return null;
    return [sumLat / totalArea, sumLng / totalArea];
  }

  function getCentroid(feat) {
    const g = feat.geometry;
    if (!g) return null;

    try {
      if (g.type === 'Polygon') {
        const c = polygonCentroid(g.coordinates);
        return c ? [c[0], c[1]] : null;
      }
      if (g.type === 'MultiPolygon') {
        let best = null;
        let bestArea = 0;
        for (const poly of g.coordinates) {
          const c = polygonCentroid(poly);
          if (!c) continue;
          let area = 0;
          for (const ring of poly) {
            for (let i = 0; i < ring.length - 1; i++) {
              area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
            }
          }
          area = Math.abs(area * 0.5);
          if (area > bestArea) {
            bestArea = area;
            best = c;
          }
        }
        return best ? [best[0], best[1]] : null;
      }
    } catch (_) {}

    try {
      const b = L.geoJSON(feat).getBounds();
      if (b.isValid()) {
        const c = b.getCenter();
        return [c.lat, c.lng];
      }
    } catch (_) {}

    return null;
  }

  // ── Map init ───────────────────────────────────────────────────────────────
  function initMap() {
    map = L.map('map', {
      center: [8.8275, 125.105],
      zoom: 12,
      zoomControl: true,
      minZoom: 10,
      maxZoom: 18,
      maxBoundsViscosity: 1.0,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
      opacity: 0.78,
      maxZoom: 19,
    }).addTo(map);

    if (L.control.fullscreen) {
      L.control.fullscreen({ position: 'topleft' }).addTo(map);
    }

    polygonLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    labelLayer = L.layerGroup().addTo(map);
  }

  function fitToGeoJSON() {
    if (!geoData?.features?.length) return;
    const layer = L.geoJSON(geoData);
    const bounds = layer.getBounds();
    if (!bounds.isValid()) return;
    cityBounds = bounds.pad(0.04);
    map.fitBounds(cityBounds, { padding: [24, 24] });
    map.setMaxBounds(cityBounds.pad(0.08));
  }

  // ── GeoJSON load (cached) ──────────────────────────────────────────────────
  async function loadGeoJSON() {
    if (geoCache) {
      geoData = geoCache;
      buildFeatureIndex();
      return true;
    }

    const res = await fetch(GEOJSON_URL);
    if (!res.ok) throw new Error(`GeoJSON not found (${res.status})`);

    const gj = await res.json();
    if (!gj?.features?.length) throw new Error('GeoJSON has no features');

    const seen = new Set();
    const features = [];

    for (const feat of gj.features) {
      const rawName = getFeatureName(feat);
      if (!rawName) {
        console.warn('[Map] Unnamed GeoJSON feature skipped:', feat.properties);
        continue;
      }
      const key = norm(rawName);
      if (seen.has(key)) {
        console.warn(`[Map] Duplicate GeoJSON barangay skipped: "${rawName}"`);
        continue;
      }
      seen.add(key);
      features.push(feat);
    }

    geoData = { ...gj, features };
    geoCache = geoData;
    buildFeatureIndex();

    console.log(`[Map] GeoJSON loaded: ${features.length} official barangay polygons.`);
    return true;
  }

  function buildFeatureIndex() {
    featureIndex.clear();
    (geoData?.features || []).forEach((feat) => {
      const name = getFeatureName(feat);
      featureIndex.set(norm(name), { feat, name, display: displayName(name) });
    });
  }

  function matchDbToGeo() {
    const matched = new Set();
    const unmatched = [];

    for (const row of barangayCases) {
      const key = norm(row.barangay);
      if (featureIndex.has(key)) {
        caseData.set(key, row);
        matched.add(key);
      } else {
        unmatched.push(row);          // keep the full row so we can show case_count
      }
    }

    // Store for renderOutside()
    unmatchedRows = unmatched;

    if (unmatched.length) {
      console.warn('[Map] DB barangays with no GeoJSON polygon (shown in "Outside / Unlocated" panel):');
      unmatched.forEach((r) => console.warn(`  • "${r.barangay}" — ${r.case_count} case(s)`));
    }

    return { matched: matched.size, unmatched: unmatched.length };
  }

  // ── Risk filter (client-side) ──────────────────────────────────────────────
  function passesRiskFilter(count) {
    const filter = document.getElementById('fRisk')?.value || 'All';
    if (filter === 'All') return true;
    return riskLevel(count) === filter;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderMap() {
    polygonLayer.clearLayers();
    markerLayer.clearLayers();
    labelLayer.clearLayers();

    if (!geoData?.features?.length) return;

    const total = summaryData.totalCases || 0;
    const riskFilter = document.getElementById('fRisk')?.value || 'All';

    geoData.features.forEach((feat) => {
      const rawName = getFeatureName(feat);
      const key = norm(rawName);
      const db = caseData.get(key) || {};
      const count = db.case_count || 0;
      const color = riskColor(count);
      const rl = riskLevel(count);
      const dimmed = riskFilter !== 'All' && rl !== riskFilter;
      const fillOp = dimmed ? 0.06 : count > 0 ? 0.48 : 0.18;
      const strokeOp = dimmed ? 0.25 : 0.92;

      if (layerOn.polygons) {
        const poly = L.geoJSON(feat, {
          style: {
            color: dimmed ? '#cbd5e1' : BORDER_COLOR,
            weight: BORDER_WEIGHT,
            opacity: strokeOp,
            fillColor: dimmed ? '#e2e8f0' : color,
            fillOpacity: fillOp,
            lineJoin: 'round',
            lineCap: 'round',
          },
          smoothFactor: 1.2,
        });

        poly.on('click', () => {
          const c = getCentroid(feat);
          if (c) showPopup(displayName(rawName), db, total, c);
        });

        poly.on('mouseover', function () {
          if (dimmed) return;
          this.setStyle({
            weight: BORDER_HOVER,
            fillOpacity: Math.min(fillOp + 0.22, 0.85),
            color: '#1d4ed8',
          });
          this.bringToFront();
        });

        poly.on('mouseout', function () {
          this.setStyle({
            weight: BORDER_WEIGHT,
            fillOpacity: fillOp,
            color: dimmed ? '#cbd5e1' : BORDER_COLOR,
            fillColor: dimmed ? '#e2e8f0' : color,
            opacity: strokeOp,
          });
        });

        poly.addTo(polygonLayer);
      }

      const centroid = getCentroid(feat);
      if (!centroid) {
        console.warn(`[Map] Centroid unavailable for "${rawName}"`);
        return;
      }
      const [lat, lng] = centroid;

      if (layerOn.markers) {
        const sz = count >= 20 ? 38 : count >= 10 ? 32 : count >= 5 ? 28 : count > 0 ? 24 : 14;
        const mColor = dimmed ? '#cbd5e1' : color;
        const html = count > 0
          ? `<div class="gis-bubble" style="width:${sz}px;height:${sz}px;background:${mColor};font-size:${sz >= 32 ? 11 : 9}px;opacity:${dimmed ? 0.4 : 1}">${count}</div>`
          : `<div class="gis-dot" style="opacity:${dimmed ? 0.2 : 0.55}"></div>`;

        const icon = L.divIcon({
          html,
          className: '',
          iconSize: [sz, sz],
          iconAnchor: [sz / 2, sz / 2],
        });

        L.marker([lat, lng], { icon, zIndexOffset: count > 0 ? 400 : 100 })
          .addTo(markerLayer)
          .on('click', () => showPopup(displayName(rawName), db, total, [lat, lng]));
      }

      if (layerOn.labels) {
        const short = displayName(rawName).replace(/^Barangay /, 'Brgy. ');
        const lIcon = L.divIcon({
          html: `<div class="gis-label">${short}</div>`,
          className: '',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        L.marker([lat, lng], { icon: lIcon, interactive: false, zIndexOffset: -200 })
          .addTo(labelLayer);
      }
    });
  }

  // ── Popup ──────────────────────────────────────────────────────────────────
  function showPopup(name, db, total, latlng) {
    const count = db.case_count || 0;
    const dogs = db.dog_cases || 0;
    const cats = db.cat_cases || 0;
    const others = db.other_cases || 0;
    const rl = riskLevel(count);
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0%';
    const lastDate = db.last_recorded_case
      ? (typeof formatDateShort === 'function'
          ? formatDateShort(db.last_recorded_case, '–')
          : String(db.last_recorded_case).slice(0, 10))
      : '–';
    const updated = summaryData.lastUpdated
      ? new Date(summaryData.lastUpdated).toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      : '–';

    const recordsUrl = `patients.html?barangay=${encodeURIComponent(name)}`;

    const html = `
      <div class="pop-hd">
        <div>
          <div class="pop-name"><i class="fa-solid fa-location-dot"></i> ${name}</div>
          <div class="pop-sub">${rl} Risk &bull; ${pct} of total</div>
        </div>
        <div class="pop-risk" style="${riskBadge(rl)}">${rl}</div>
      </div>
      <div class="pop-body">
        <div class="pop-row"><span class="pop-lbl">Total Cases</span><span class="pop-val pop-accent">${count}</span></div>
        <div class="pop-row"><span class="pop-lbl">Dog Cases</span><span class="pop-val">${dogs}</span></div>
        <div class="pop-row"><span class="pop-lbl">Cat Cases</span><span class="pop-val">${cats}</span></div>
        <div class="pop-row"><span class="pop-lbl">Other Animals</span><span class="pop-val">${others}</span></div>
        <div class="pop-divider">Risk Analysis</div>
        <div class="pop-row"><span class="pop-lbl">Risk Level</span>
          <span class="pop-val" style="padding:2px 8px;border-radius:99px;font-size:10px;${riskBadge(rl)}">${rl}</span></div>
        <div class="pop-row"><span class="pop-lbl">Percentage</span><span class="pop-val">${pct}</span></div>
        <div class="pop-row"><span class="pop-lbl">Last Recorded</span><span class="pop-val">${lastDate}</span></div>
        <div class="pop-row"><span class="pop-lbl">Data Updated</span><span class="pop-val">${updated}</span></div>
      </div>
      <a href="${recordsUrl}" class="pop-btn"><i class="fa-solid fa-arrow-up-right-from-square"></i> View Records</a>`;

    L.popup({ maxWidth: 300, closeButton: true, autoPan: true, className: 'gis-popup' })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(map);
  }

  // ── Statistics panel ───────────────────────────────────────────────────────
  function renderStats() {
    const s = summaryData;
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val ?? '–';
    };

    set('st-total', s.totalCases ?? 0);
    set('st-highest', s.highestBarangay || '–');
    set('st-animal', s.mostCommonAnimal || '–');
    set('st-affected', s.affectedBarangays ?? 0);
    set('st-risk', s.riskLevel || '–');
  }

  // ── Outside / Unlocated barangays ──────────────────────────────────────────
  // Rows returned by the API that have no matching GeoJSON polygon are invisible
  // on the map. This function surfaces them in the sidebar so nurses can see
  // cases recorded as "Others" (outside Gingoog City) or with a misspelled name.
  function renderOutside() {
    const card = document.getElementById('outsideCard');
    const el   = document.getElementById('outsideList');
    if (!el) return;

    if (!unmatchedRows.length) {
      if (card) card.style.display = 'none';
      return;
    }

    if (card) card.style.display = '';

    const total = unmatchedRows.reduce((s, r) => s + Number(r.case_count || 0), 0);
    const rows  = unmatchedRows
      .slice()
      .sort((a, b) => Number(b.case_count) - Number(a.case_count));

    el.innerHTML = `
      <div style="font-size:11px;color:#64748b;margin-bottom:8px;">
        ${rows.length} location${rows.length !== 1 ? 's' : ''} not on the Gingoog City map
        &nbsp;·&nbsp; <strong>${total}</strong> total case${total !== 1 ? 's' : ''}
      </div>
      ${rows.map(r => {
        const name = r.barangay || '—';
        const isOthers = name.toLowerCase() === 'others' || name.toLowerCase().startsWith('others');
        const icon = isOthers
          ? '<i class="fa-solid fa-earth-asia" style="color:#f59e0b;font-size:10px;margin-right:4px;"></i>'
          : '<i class="fa-solid fa-location-dot-slash" style="color:#94a3b8;font-size:10px;margin-right:4px;"></i>';
        return `<div class="top-item" style="border-left:3px solid ${isOthers ? '#f59e0b' : '#94a3b8'};padding-left:6px;margin-bottom:4px;">
          <div>${icon}<span class="top-name">${name}</span></div>
          <span class="top-badge" style="background:#f1f5f9;color:#475569;border-radius:99px;padding:2px 8px;font-size:11px;font-weight:700;">${r.case_count}</span>
        </div>`;
      }).join('')}`;
  }

  // ── Top barangays ──────────────────────────────────────────────────────────
  function renderTop() {
    const el = document.getElementById('topList');
    if (!el) return;

    const riskFilter = document.getElementById('fRisk')?.value || 'All';
    let list = [...barangayCases].filter((b) => b.case_count > 0);
    if (riskFilter !== 'All') {
      list = list.filter((b) => riskLevel(b.case_count) === riskFilter);
    }
    list.sort((a, b) => b.case_count - a.case_count || String(a.barangay).localeCompare(String(b.barangay)));
    const ranked = [];
    list.forEach((row, index) => {
      let rank = index + 1;
      if (index > 0 && row.case_count === list[index - 1].case_count) rank = ranked[index - 1].rank;
      ranked.push({ ...row, rank });
    });
    const top = ranked.slice(0, 8);
    const last = top[top.length - 1];
    if (last) {
      ranked.slice(8).forEach((row) => {
        if (row.case_count === last.case_count) top.push(row);
      });
    }

    if (!top.length) {
      el.innerHTML = '<div class="gis-empty">No cases for current filters.</div>';
      return;
    }

    el.innerHTML = top.map((b) => {
      const tied = top.filter((row) => row.case_count === b.case_count).length > 1;
      return `
      <div class="top-item">
        <div><span class="top-rank">#${b.rank}${tied ? ' tie' : ''}</span><span class="top-name">${esc(b.barangay)}</span></div>
        <span class="top-badge" style="${riskBadge(riskLevel(b.case_count))}">${b.case_count}</span>
      </div>`;
    }).join('');
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function caseWord(count) {
    const n = Number(count) || 0;
    return `${n} case${n === 1 ? '' : 's'}`;
  }

  // ── AI Recommendations ─────────────────────────────────────────────────────
  function renderAI() {
    const el = document.getElementById('aiList');
    if (!el) return;

    const s = summaryData || {};
    const recs = [];
    const leaders = Array.isArray(s.highestBarangays) ? s.highestBarangays : [];
    const total = Number(s.totalCases) || 0;
    const animals = s.animalCounts || {};

    if (!total) {
      recs.push({
        icon: 'fa-circle-info',
        cls: 'rec-info',
        text: '<strong>Geographic Hotspot:</strong> No bite cases were recorded for this period, so no hotspot is identified.',
      });
    } else if (s.highestTied && leaders.length > 1) {
      recs.push({
        icon: 'fa-triangle-exclamation',
        cls: 'rec-danger',
        text: `<strong>Geographic Hotspot:</strong> ${esc(leaders.join(' and '))} are tied for the highest recorded bite case count (${caseWord(s.highestBarangayCases)} each). Surveillance should cover each of these barangays.`,
      });
    } else if (s.highestBarangay && s.highestBarangay !== 'N/A') {
      recs.push({
        icon: 'fa-triangle-exclamation',
        cls: 'rec-danger',
        text: `<strong>Geographic Hotspot:</strong> ${esc(s.highestBarangay)} has the highest recorded bite case count (${caseWord(s.highestBarangayCases)}). Prioritize surveillance and bite prevention outreach in this barangay.`,
      });
    }

    const lowest = Array.isArray(s.lowestRiskBarangays) ? s.lowestRiskBarangays : [];
    if (lowest.length) {
      const names = lowest.map((b) => esc(b.barangay)).join(', ');
      const count = lowest[0].case_count;
      recs.push({
        icon: 'fa-circle-check',
        cls: 'rec-success',
        text: `<strong>Lowest recorded count:</strong> ${names} — ${caseWord(count)} each, below the highest recorded count. Continue routine monitoring in these barangays.`,
      });
    }

    if (!total || s.mostCommonAnimal === 'N/A') {
      recs.push({
        icon: 'fa-paw',
        cls: 'rec-info',
        text: '<strong>Most Common Animal:</strong> No biting animal was recorded for this period.',
      });
    } else if (String(s.mostCommonAnimal).includes('(Tie)')) {
      recs.push({
        icon: 'fa-paw',
        cls: 'rec-info',
        text: `<strong>Most Common Animal:</strong> ${esc(s.mostCommonAnimal)} share the highest recorded count (Dog ${Number(animals.dog) || 0}, Cat ${Number(animals.cat) || 0}, Other ${Number(animals.other) || 0}).`,
      });
    } else {
      const animalKey = s.mostCommonAnimal === 'Cat' ? 'cat' : s.mostCommonAnimal === 'Other' ? 'other' : 'dog';
      const animalCount = Number(animals[animalKey]) || 0;
      recs.push({
        icon: 'fa-paw',
        cls: 'rec-info',
        text: `<strong>Most Common Animal:</strong> ${esc(s.mostCommonAnimal)} accounts for ${animalCount} of ${total} recorded bite cases.`,
      });
    }

    const trend = s.trend || {};
    if (trend.previousTotal == null) {
      recs.push({
        icon: 'fa-chart-line',
        cls: 'rec-info',
        text: '<strong>Case Trend:</strong> No previous period is selected, so a trend is not calculated.',
      });
    } else {
      const prev = Number(trend.previousTotal) || 0;
      const current = Number(trend.currentTotal) || 0;
      const change = Number(trend.change) || (current - prev);
      const period = esc(trend.label || 'previous period');
      if (trend.direction === 'increasing') {
        recs.push({
          icon: 'fa-chart-line',
          cls: 'rec-danger',
          text: `<strong>Case Trend:</strong> Recorded cases increased from ${prev} in the ${period} to ${current} (${change > 0 ? '+' : ''}${change}).`,
        });
      } else if (trend.direction === 'decreasing') {
        recs.push({
          icon: 'fa-chart-line',
          cls: 'rec-success',
          text: `<strong>Case Trend:</strong> Recorded cases decreased from ${prev} in the ${period} to ${current} (${change}).`,
        });
      } else {
        recs.push({
          icon: 'fa-chart-line',
          cls: 'rec-info',
          text: `<strong>Case Trend:</strong> Recorded cases are unchanged at ${current} compared with the ${period}.`,
        });
      }
    }

    const rl = s.riskLevel || 'Insufficient Data';
    if (rl === 'Critical' || rl === 'High') {
      recs.push({ icon: 'fa-shield-halved', cls: 'rec-danger', text: `<strong>Overall Risk: ${esc(rl)}</strong> — this is the highest barangay tier for the selected period (Low 1–4, Medium 5–9, High 10–19, Critical 20+).` });
    } else if (rl === 'Medium') {
      recs.push({ icon: 'fa-shield-halved', cls: 'rec-warn', text: '<strong>Overall Risk: Medium</strong> — the highest barangay tier for this period is Medium (5–9 recorded cases).' });
    } else if (rl === 'Low') {
      recs.push({ icon: 'fa-shield-halved', cls: 'rec-success', text: '<strong>Overall Risk: Low</strong> — the highest barangay tier for this period is Low (1–4 recorded cases).' });
    } else if (rl === 'No Cases') {
      recs.push({ icon: 'fa-shield-halved', cls: 'rec-info', text: '<strong>Overall Risk: No Cases</strong> — no bite cases were recorded for this period.' });
    } else {
      recs.push({ icon: 'fa-shield-halved', cls: 'rec-info', text: '<strong>Overall Risk: Insufficient Data</strong> — recorded cases could not be matched to a barangay risk tier.' });
    }

    el.innerHTML = recs.map((r) => `
      <div class="ai-rec ${r.cls}">
        <i class="fa-solid ${r.icon}"></i>
        <span>${r.text}</span>
      </div>`).join('');
  }

  // ── Data fetch ─────────────────────────────────────────────────────────────
  async function loadMapData() {
    const loading = document.getElementById('mapLoading');
    if (loading) loading.style.display = 'flex';

    const animal = document.getElementById('fAnimal')?.value || 'All';
    const dtype = document.getElementById('fDateType')?.value || '';
    const dval = document.getElementById('fDateVal')?.value || '';

    const qs = new URLSearchParams();
    if (animal !== 'All') qs.append('animalType', animal);
    if (dtype) {
      qs.append('dateFilter', dtype);
      qs.append('dateValue', dval);
    }

    try {
      const res = await fetch('/api/analytics/map-data?' + qs);
      const json = await res.json();
      if (!json.success) throw new Error(json.message || 'API error');

      barangayCases = json.data.barangayCases || [];
      summaryData = json.data.summary || {};

      caseData.clear();
      const match = matchDbToGeo();

      renderStats();
      renderTop();
      renderAI();
      renderOutside();
      renderMap();

      const status = document.getElementById('mapStatus');
      if (status) {
        status.textContent = `${featureIndex.size} barangays · ${match.matched} matched · ${match.unmatched} unmatched`;
      }
    } catch (err) {
      console.error('[Map] Data load error:', err);
    } finally {
      if (loading) loading.style.display = 'none';
    }
  }

  // ── Layer toggle ───────────────────────────────────────────────────────────
  function toggleLayer(type) {
    layerOn[type] = !layerOn[type];
    const btnMap = { polygons: 'btnPolygons', markers: 'btnMarkers', labels: 'btnLabels' };
    const btn = document.getElementById(btnMap[type]);
    if (btn) btn.classList.toggle('on', layerOn[type]);
    renderMap();
  }

  function handleDateChange() {
    const v = document.getElementById('fDateType')?.value || '';
    const now = new Date();
    const inp = document.getElementById('fDateVal');
    const lbl = document.getElementById('dateLabel');
    const wrap = document.getElementById('dateWrap');
    if (wrap) wrap.style.display = v ? '' : 'none';

    if (!inp) return;

    if (v === 'monthly') {
      if (lbl) lbl.textContent = 'Month';
      inp.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      inp.placeholder = 'YYYY-MM';
    } else if (v === 'quarterly') {
      if (lbl) lbl.textContent = 'Quarter';
      inp.value = `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
      inp.placeholder = 'YYYY-Q1';
    } else if (v === 'yearly') {
      if (lbl) lbl.textContent = 'Year';
      inp.value = `${now.getFullYear()}`;
      inp.placeholder = 'YYYY';
    }

    loadMapData();
  }

  function onFilterChange() {
    renderTop();
    renderAI();
    renderOutside();
    renderMap();
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  async function boot() {
    initMap();

    try {
      await loadGeoJSON();
      fitToGeoJSON();
      document.getElementById('geoErrorBanner').style.display = 'none';
    } catch (err) {
      console.error('[Map] GeoJSON error:', err.message);
      document.getElementById('geoErrorBanner').style.display = 'block';
      document.getElementById('mapLoading').style.display = 'none';
      return;
    }

    const now = new Date();
    const fDateVal = document.getElementById('fDateVal');
    if (fDateVal && !fDateVal.value) {
      fDateVal.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    await loadMapData();
    setInterval(loadMapData, 60_000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  global.GisMap = {
    boot,
    loadMapData,
    toggleLayer,
    handleDateChange,
    onFilterChange,
  };
})(window);
