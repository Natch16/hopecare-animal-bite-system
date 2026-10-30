/**
 * Nurse-only missed-dose / restart-from-Day-0 workflow UI.
 * Restart is never available in the patient portal.
 */
(function (global) {
  const CONFIRM_TEXT =
    "This patient's treatment is incomplete due to a missed scheduled dose. Confirming this action will stop the previous schedule and create a new vaccination schedule starting from Day 0 according to the clinic-approved protocol.";

  function esc(v) {
    if (v == null) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    const raw = String(d).replace('T', ' ');
    const date = fmt(raw.slice(0, 10));
    const time = raw.match(/(\d{2}:\d{2})/);
    return time ? `${date} ${time[1]}` : date;
  }

  function fmt(d) {
    if (!d) return '—';
    if (typeof formatDateShort === 'function') return formatDateShort(d, '—');
    const iso = String(d).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(d);
    const [y, mo, da] = iso.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1] + ` ${da}, ${y}`;
  }

  function todayIso() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }

  function isIncompleteStatus(s) {
    return s === 'Incomplete' || s === 'Treatment Interrupted';
  }

  function canConfirmRestart() {
    return !!(global.RBAC && RBAC.hasPermission && RBAC.hasPermission('treatment_restart'));
  }

  function workflowOf(ep) {
    return (ep && ep.workflow) || {};
  }

  function renderBanner(ep, extras) {
    const wf = workflowOf(ep);
    const status = (ep && (ep.treatmentStatus || ep.status)) || wf.workflow_status;
    const x = extras || {};
    if (!isIncompleteStatus(status) && wf.restart_status !== 'Restart Required') return '';

    const episodeId = x.episodeId || (ep && ep.episode_id);
    const patientId = x.patientId || (ep && ep.patient_id);
    const missed = wf.missed_dose_label || ep.missed_dose || x.missedDose || '—';
    const due = fmt(wf.missed_due_date || ep.missed_date || x.missedDate);
    const detected = fmt(wf.missed_detected_at || ep.missed_detected_at);
    const delayed = wf.days_delayed != null ? wf.days_delayed : (x.daysDelayed != null ? x.daysDelayed : '—');
    const can = canConfirmRestart();
    const blocked = !!wf.restart_blocked;
    const blockReason = wf.restart_block_reason
      || 'This case cannot be restarted because the patient already has a current active treatment case. The current treatment schedule should be managed under the patient\'s latest active case.';

    return `<div class="md-banner" style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;padding:14px 16px;margin:10px 0 14px;color:#7f1d1d;">
      <div style="font-weight:800;font-size:13px;margin-bottom:6px;">
        <i class="fa-solid fa-circle-exclamation"></i> ${blocked ? 'Restart Not Available' : 'Treatment Incomplete — Restart Required'}
      </div>
      <p style="margin:0 0 10px;font-size:12.5px;line-height:1.5;">
        ${blocked
          ? esc(blockReason)
          : 'A scheduled dose was missed. The original vaccination schedule is stopped. The patient must not continue from the missed dose. Confirm a restart from Day 0 on this same case — do not create a New Case for a missed dose.'}
      </p>
      ${blocked ? '<div style="margin:0 0 10px;font-size:12.5px;font-weight:700;">Restart Required<br><span style="font-weight:600;">⚠ Restart unavailable — Patient has an active current case.</span></div>' : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;font-size:12px;margin-bottom:10px;">
        <div><span style="color:#9f1239;font-weight:700;display:block;">Missed dose</span>${esc(missed)}</div>
        <div><span style="color:#9f1239;font-weight:700;display:block;">Original due date</span>${due}</div>
        <div><span style="color:#9f1239;font-weight:700;display:block;">Detected</span>${detected}</div>
        <div><span style="color:#9f1239;font-weight:700;display:block;">Days delayed</span>${esc(delayed)}</div>
        <div><span style="color:#9f1239;font-weight:700;display:block;">Schedule</span>Stopped</div>
        <div><span style="color:#9f1239;font-weight:700;display:block;">Restart status</span>${blocked ? 'Restart Required' : esc(wf.restart_status || 'Restart Required')}</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${x.hideHistory ? '' : `<a class="md-btn" href="/nurse/patient-episodes.html?id=${esc(patientId)}" style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #fca5a5;color:#991b1b;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;text-decoration:none;"><i class="fa-solid fa-timeline"></i> View Treatment History</a>`}
        ${episodeId ? `<button type="button" class="md-btn" onclick="TreatmentRestart.openHistory(${Number(episodeId)})" style="background:#fff;border:1px solid #fca5a5;color:#991b1b;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-clock-rotate-left"></i> View Restart History</button>` : ''}
        ${can && episodeId && !blocked ? `<button type="button" class="md-btn" onclick="TreatmentRestart.openConfirm(${Number(episodeId)}, ${Number(patientId)})" style="background:#b91c1c;border:none;color:#fff;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-rotate"></i> Confirm Restart</button>` : ''}
      </div>
    </div>`;
  }

  function renderRestartSummary(ep) {
    const wf = workflowOf(ep);
    if (!wf.last_restart) return '';
    const r = wf.last_restart;
    return `<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:10px 12px;margin:8px 0 12px;font-size:12px;color:#065f46;">
      <strong><i class="fa-solid fa-circle-check"></i> Restart Confirmed</strong>
      — Day 0 on ${fmt(r.restart_date)} by ${esc(r.confirmed_by || 'staff')}.
      Cycle ${esc(r.new_cycle)}. ${r.note ? 'Note: ' + esc(r.note) : ''}
    </div>`;
  }

  function ensureModal() {
    if (document.getElementById('mdRestartModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'mdRestartModal';
    wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9999;align-items:center;justify-content:center;padding:20px;';
    wrap.innerHTML = `
      <style>
        .md-card { background:#fff; border-radius:18px; max-width:560px; width:100%; max-height:90vh; overflow:auto; box-shadow:0 20px 50px rgba(15,23,42,.22); }
        .md-card.md-wide { max-width:860px; }
        .md-head { padding:16px 18px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; background:#fff; z-index:2; }
        .md-kicker { font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:#4274D9; margin:0 0 2px; }
        .rh-meta { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 14px; }
        .rh-chip { background:#f8fafc; border:1px solid #e2e8f0; border-radius:999px; padding:5px 10px; font-size:12px; color:#334155; }
        .rh-chip strong { color:#0f172a; }
        .rh-section { margin:0 0 16px; }
        .rh-section h4 { margin:0 0 8px; font-size:13px; color:#293681; }
        .rh-card { border:1px solid #e2e8f0; border-radius:14px; padding:12px 14px; margin-bottom:10px; background:#fff; }
        .rh-card.stopped { background:#fff7f7; border-color:#fecaca; }
        .rh-card.active { background:#f8fbff; border-color:#bfdbfe; }
        .rh-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px 14px; }
        .rh-label { display:block; font-size:10px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; color:#64748b; margin-bottom:2px; }
        .rh-value { font-size:13px; color:#0f172a; font-weight:600; }
        .rh-note { margin-top:10px; background:#f8fafc; border-radius:10px; padding:8px 10px; font-size:12px; color:#334155; line-height:1.45; }
        .rh-table { width:100%; border-collapse:collapse; font-size:12px; }
        .rh-table th { text-align:left; font-size:10px; letter-spacing:.03em; text-transform:uppercase; color:#64748b; padding:6px 8px; border-bottom:1px solid #e2e8f0; }
        .rh-table td { padding:7px 8px; border-bottom:1px solid #f1f5f9; color:#0f172a; }
        .rh-pill { display:inline-flex; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:700; background:#f1f5f9; color:#475569; }
        .rh-pill.ok { background:#dcfce7; color:#166534; }
        .rh-pill.warn { background:#ffedd5; color:#9a3412; }
        .rh-pill.bad { background:#fee2e2; color:#991b1b; }
        .rh-time { display:flex; gap:10px; padding:8px 0; border-bottom:1px solid #f1f5f9; }
        .rh-dot { width:8px; height:8px; border-radius:50%; background:#4274D9; margin-top:5px; flex:none; }
        .rh-empty { font-size:12px; color:#64748b; margin:0; }
      </style>
      <div class="md-card" id="mdRestartCard">
        <div class="md-head">
          <div>
            <p class="md-kicker" id="mdRestartKicker">Treatment</p>
            <h3 id="mdRestartTitle" style="margin:0;font-size:16px;color:#1e293b;">Confirm Restart from Day 0</h3>
          </div>
          <button type="button" onclick="TreatmentRestart.close()" style="border:none;background:#f1f5f9;width:32px;height:32px;border-radius:8px;font-size:18px;cursor:pointer;color:#64748b;">×</button>
        </div>
        <div id="mdRestartBody" style="padding:16px 18px;"></div>
      </div>`;
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
  }

  function close() {
    const m = document.getElementById('mdRestartModal');
    if (m) m.style.display = 'none';
  }

  function setHistoryMode(on) {
    const card = document.getElementById('mdRestartCard');
    const kicker = document.getElementById('mdRestartKicker');
    if (card) card.classList.toggle('md-wide', on);
    if (kicker) kicker.textContent = on ? 'Same case · no new exposure' : 'Treatment';
  }

  const EVENT_LABEL = {
    MISSED_DOSE_DETECTED: 'Missed dose detected',
    TREATMENT_INCOMPLETE: 'Treatment marked incomplete',
    SCHEDULE_STOPPED: 'Previous schedule stopped',
    PATIENT_RETURNED: 'Patient returned',
    RESTART_CONFIRMED: 'Restart confirmed',
    NEW_SCHEDULE_CREATED: 'New Day 0 schedule created',
  };

  function statusPill(status) {
    const s = String(status || '—');
    const kind = /stopped|missed|incomplete/i.test(s) ? 'bad'
      : /pending|required/i.test(s) ? 'warn'
      : /given|completed|active|confirmed|ongoing/i.test(s) ? 'ok' : '';
    return `<span class="rh-pill ${kind}">${esc(s)}</span>`;
  }

  function field(label, value) {
    return `<div><span class="rh-label">${label}</span><div class="rh-value">${value}</div></div>`;
  }

  function showRestartBlocked(reason) {
    document.getElementById('mdRestartTitle').textContent = 'Restart Not Available';
    document.getElementById('mdRestartBody').innerHTML = `
      <p style="font-size:13px;line-height:1.55;color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px;margin:0;">
        <strong>Restart Required</strong><br>
        ⚠ Restart unavailable — Patient has an active current case.
      </p>
      <p style="font-size:13px;line-height:1.55;color:#334155;margin:12px 0 0;">${esc(reason || 'This case cannot be restarted because the patient already has a current active treatment case. The current treatment schedule should be managed under the patient\'s latest active case.')}</p>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" onclick="TreatmentRestart.close()" style="padding:8px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;">Close</button>
      </div>`;
  }

  async function openConfirm(episodeId, patientId) {
    if (!canConfirmRestart()) {
      alert('Only an authorized nurse can confirm a treatment restart.');
      return;
    }
    ensureModal();
    setHistoryMode(false);
    document.getElementById('mdRestartTitle').textContent = 'Confirm Restart from Day 0';
    document.getElementById('mdRestartBody').innerHTML = '<p style="font-size:13px;color:#64748b;margin:0;">Checking this case…</p>';
    document.getElementById('mdRestartModal').style.display = 'flex';
    try {
      const check = await fetch(`/api/episodes/${episodeId}/restart-history`);
      const checked = await check.json();
      if (checked.success && checked.data && checked.data.workflow && checked.data.workflow.restart_blocked) {
        showRestartBlocked(checked.data.workflow.restart_block_reason);
        return;
      }
    } catch (e) {
      /* The restart request itself still checks the database. */
    }
    document.getElementById('mdRestartBody').innerHTML = `
      <p style="font-size:13px;line-height:1.55;color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px;">${esc(CONFIRM_TEXT)}</p>
      <label style="display:block;font-size:12px;font-weight:700;margin:12px 0 4px;">Patient returned on</label>
      <input type="date" id="mdReturnedOn" value="${todayIso()}" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;">
      <label style="display:block;font-size:12px;font-weight:700;margin:12px 0 4px;">Restart date (Day 0)</label>
      <input type="date" id="mdRestartDate" value="${todayIso()}" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;">
      <label style="display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:13px;">
        <input type="checkbox" id="mdConfirm" style="margin-top:3px;"> I confirm this restart according to the clinic-approved protocol
      </label>
      <label style="display:block;font-size:12px;font-weight:700;margin:12px 0 4px;">Assessment / restart note</label>
      <textarea id="mdNote" rows="3" maxlength="1000" placeholder="Required note" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;resize:vertical;"></textarea>
      <div id="mdRestartErr" style="display:none;margin-top:10px;color:#b91c1c;font-size:12px;font-weight:600;"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" onclick="TreatmentRestart.close()" style="padding:8px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;">Cancel</button>
        <button type="button" id="mdSubmitBtn" onclick="TreatmentRestart.submit(${Number(episodeId)}, ${Number(patientId)})" style="padding:8px 14px;border-radius:8px;border:none;background:#b91c1c;color:#fff;font-weight:700;cursor:pointer;">Confirm Restart</button>
      </div>`;
    document.getElementById('mdRestartModal').style.display = 'flex';
  }

  async function submit(episodeId, patientId) {
    const err = document.getElementById('mdRestartErr');
    const btn = document.getElementById('mdSubmitBtn');
    const show = (m) => { err.style.display = 'block'; err.textContent = m; };
    if (!document.getElementById('mdConfirm').checked) {
      show('Check "I confirm this restart according to the clinic-approved protocol" before confirming the restart.');
      return;
    }
    const note = (document.getElementById('mdNote').value || '').trim();
    if (note.length < 5) { show('A restart note is required.'); return; }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/episodes/${episodeId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_id: patientId,
          confirm: true,
          patient_returned_on: document.getElementById('mdReturnedOn').value,
          restart_date: document.getElementById('mdRestartDate').value,
          note,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 403) {
        show('Only an authorized nurse can confirm a treatment restart.');
        btn.disabled = false;
        btn.textContent = 'Confirm Restart';
        return;
      }
      if (!json.success) {
        show(json.message || 'Restart could not be confirmed.');
        btn.disabled = false;
        btn.textContent = 'Confirm Restart';
        return;
      }
      close();
      const savedPatientId = (json.data && json.data.patientId) || patientId;
      window.location.href = `/nurse/patients.html?action=edit&id=${encodeURIComponent(savedPatientId)}`;
    } catch (e) {
      show('Restart could not be confirmed.');
      btn.disabled = false;
      btn.textContent = 'Confirm Restart';
    }
  }

  async function openHistory(episodeId) {
    ensureModal();
    setHistoryMode(true);
    document.getElementById('mdRestartTitle').textContent = 'Restart & Status History';
    document.getElementById('mdRestartBody').innerHTML = '<p class="rh-empty">Loading history…</p>';
    document.getElementById('mdRestartModal').style.display = 'flex';
    try {
      const res = await fetch(`/api/episodes/${episodeId}/restart-history`);
      const json = await res.json();
      if (!json.success) {
        document.getElementById('mdRestartBody').innerHTML = `<p class="rh-empty">${esc(json.message || 'Unable to load history.')}</p>`;
        return;
      }
      const d = json.data;
      const wf = d.workflow || {};
      const restarts = d.restarts || [];
      const hist = d.status_history || [];
      const sched = d.schedule || [];
      const cycles = [...new Set(sched.map((s) => Number(s.treatment_cycle) || 1))];
      const currentCycle = Number(wf.treatment_cycle) || cycles[cycles.length - 1] || 1;

      const restartCards = restarts.length ? restarts.map((r) => {
        const day0 = sched.find((s) => Number(s.treatment_cycle) === Number(r.new_cycle) && s.day_label === 'Day 0');
        const prevRows = sched.filter((s) => Number(s.treatment_cycle) === Number(r.previous_cycle));
        const prevStatus = prevRows.some((s) => s.status === 'Stopped')
          ? 'Stopped'
          : (prevRows.find((s) => s.status) || {}).status || 'Stopped';
        return `<article class="rh-card">
          <div class="rh-grid">
            ${field('Missed dose', esc(r.missed_dose || '—'))}
            ${field('Original due date', fmt(r.missed_due_date))}
            ${field('Days delayed', esc(r.days_delayed != null ? r.days_delayed : '—'))}
            ${field('Previous schedule', statusPill(prevStatus))}
            ${field('Patient returned', fmt(r.patient_returned_on))}
            ${field('New Day 0', fmt(r.restart_date))}
            ${field('New Day 0 status', day0 ? statusPill(day0.status || 'Pending') : statusPill('Pending'))}
            ${field('New cycle', 'Cycle ' + esc(r.new_cycle))}
            ${field('Protocol doses', esc(r.protocol_days || '—'))}
            ${field('Confirmed by', esc(r.confirmed_by || '—') + (r.confirmed_by_role ? ' · ' + esc(r.confirmed_by_role) : ''))}
            ${field('Confirmed at', fmtDateTime(r.created_at))}
          </div>
          <div class="rh-note"><span class="rh-label">Assessment / restart note</span>${esc(r.note || '—')}</div>
        </article>`;
      }).join('') : '<p class="rh-empty">No restart has been confirmed for this case.</p>';

      const cycleCards = cycles.length ? cycles.map((cycle) => {
        const rows = sched.filter((s) => (Number(s.treatment_cycle) || 1) === cycle);
        const active = cycle === currentCycle && wf.schedule_status !== 'Stopped';
        const stopped = rows.some((s) => s.status === 'Stopped') && cycle !== currentCycle;
        return `<article class="rh-card ${stopped ? 'stopped' : (active ? 'active' : '')}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong style="color:#293681;">Cycle ${cycle}</strong>
            ${statusPill(cycle === currentCycle ? (wf.schedule_status || 'Active') : (stopped ? 'Stopped' : 'Previous'))}
          </div>
          <table class="rh-table">
            <thead><tr><th>Dose</th><th>Due</th><th>Given</th><th>Brand</th><th>Status</th></tr></thead>
            <tbody>${rows.map((row) => `<tr>
              <td>${esc(row.day_label)}</td>
              <td>${fmt(row.date_due)}</td>
              <td>${fmt(row.date_given)}</td>
              <td>${esc(row.vaccine_brand || '—')}</td>
              <td>${statusPill(row.status || '—')}</td>
            </tr>`).join('')}</tbody>
          </table>
        </article>`;
      }).join('') : '<p class="rh-empty">No vaccination schedule is stored for this case.</p>';

      const audit = hist.length ? hist.map((h) => `<div class="rh-time">
        <span class="rh-dot"></span>
        <div>
          <div class="rh-value">${esc(EVENT_LABEL[h.event] || h.event || 'Status change')}</div>
          <div style="font-size:12px;color:#475569;margin-top:2px;">${statusPill(h.previous_status || '—')} → ${statusPill(h.new_status || '—')}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">${fmtDateTime(h.created_at)} · ${esc(h.staff_name || h.source || 'system')}${h.dose_label ? ' · ' + esc(h.dose_label) : ''}${h.treatment_cycle ? ' · Cycle ' + esc(h.treatment_cycle) : ''}</div>
          ${h.note ? `<div class="rh-note">${esc(h.note)}</div>` : ''}
        </div>
      </div>`).join('') : '<p class="rh-empty">No status changes are recorded yet.</p>';

      document.getElementById('mdRestartBody').innerHTML = `
        <div class="rh-meta">
          <span class="rh-chip"><strong>${esc(d.patient_id_display || 'Patient')}</strong></span>
          <span class="rh-chip">Case #${esc(d.case_number)}</span>
          <span class="rh-chip">Exposure ${fmt(d.date_of_exposure)}</span>
          <span class="rh-chip">Current cycle ${esc(currentCycle)}</span>
          <span class="rh-chip">${statusPill(wf.workflow_status || '—')}</span>
          <span class="rh-chip">${statusPill(wf.restart_status || 'No restart')}</span>
        </div>
        ${wf.restart_blocked ? `<p class="rh-note" style="margin-bottom:14px;"><strong>Restart Not Available.</strong> ${esc(wf.restart_block_reason || 'This case cannot be restarted because the patient already has a current active treatment case.')}</p>` : ''}
        <section class="rh-section">
          <h4>Restart record</h4>
          ${restartCards}
        </section>
        <section class="rh-section">
          <h4>Vaccination schedule by cycle</h4>
          ${cycleCards}
        </section>
        <section class="rh-section">
          <h4>Status history</h4>
          ${audit}
        </section>
      `;
    } catch (e) {
      document.getElementById('mdRestartBody').innerHTML = '<p class="rh-empty">Unable to load history.</p>';
    }
  }

  global.TreatmentRestart = {
    CONFIRM_TEXT,
    isIncompleteStatus,
    canConfirmRestart,
    renderBanner,
    renderRestartSummary,
    openConfirm,
    openHistory,
    submit,
    close,
  };
})(window);
