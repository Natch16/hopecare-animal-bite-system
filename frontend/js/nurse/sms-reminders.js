(function (global) {
  const TYPE_LABEL = {
    ACCOUNT_ACCESS: 'Account Access',
    '3_DAYS_BEFORE': '3-Day Reminder',
    '1_DAY_BEFORE': '1-Day Reminder',
    SAME_DAY: 'Same-Day Reminder',
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDate(value) {
    const iso = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return '—';
    const [y, mo, da] = iso.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1] + ` ${da}, ${y}`;
  }

  function fmtWhen(value) {
    if (!value) return '—';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return fmtDate(value);
    return dt.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  function statusBadge(status) {
    const s = String(status || '—');
    const cls = {
      Sent: 'sms-ok', Accepted: 'sms-ok', Pending: 'sms-pending',
      Failed: 'sms-fail', Skipped: 'sms-skip', Cancelled: 'sms-skip', Disabled: 'sms-skip',
    }[s] || 'sms-skip';
    const label = s === 'Sent' ? 'Accepted' : s;
    return `<span class="sms-badge ${cls}">${esc(label)}</span>`;
  }

  async function load(patientId) {
    const res = await fetch(`/api/sms/patient/${patientId}/logs`);
    return res.json();
  }

  function renderSection(hostId, payload, episodeId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    const allLogs = payload.data || [];
    const caseId = Number(episodeId) || 0;
    const logs = caseId
      ? allLogs.filter((r) => !r.episode_id || Number(r.episode_id) === caseId)
      : allLogs;
    const p = payload.patient || {};
    const next = p.next_dose;
    const latest = logs[0];
    const incomplete = /incomplete|interrupted/i.test(String(p.treatment_status || ''));
    const blockReason = p.block_reason
      || (!p.phone_valid ? 'A valid Philippine mobile number is required before SMS can be sent.' : '')
      || (incomplete ? 'This treatment is incomplete. An ordinary next-dose reminder cannot be sent.' : '')
      || (!next || !next.dateDue ? 'There is no active upcoming dose to remind.' : '');
    host.innerHTML = `
      <div class="fu-section sms-section">
        <h4><i class="fa-solid fa-comment-sms" style="color:#4274D9;margin-right:5px;"></i> SMS Reminders</h4>
        <div id="smsNotify" class="sms-notify" hidden></div>
        <div class="fu-detail-grid">
          <div class="fu-detail-item"><div class="di-label">Dose Day</div><div class="di-value">${esc(next && next.label ? next.label : '—')}</div></div>
          <div class="fu-detail-item"><div class="di-label">Scheduled Date</div><div class="di-value">${next && next.dateDue ? fmtDate(next.dateDue) : '—'}</div></div>
          <div class="fu-detail-item"><div class="di-label">Reminder</div><div class="di-value">${latest ? esc(TYPE_LABEL[latest.reminder_type] || latest.reminder_type) : 'Not sent'}</div></div>
          <div class="fu-detail-item"><div class="di-label">SMS Status</div><div class="di-value">${latest ? statusBadge(latest.status) : 'Not sent'}</div></div>
          <div class="fu-detail-item"><div class="di-label">Last Attempt</div><div class="di-value">${latest ? esc(fmtWhen(latest.sent_at || latest.created_at)) : '—'}</div></div>
          <div class="fu-detail-item"><div class="di-label">Result</div><div class="di-value">${latest && latest.error_message ? esc(latest.error_message) : (latest && latest.status === 'Sent' ? 'Accepted by IPROG SMS' : '—')}</div></div>
        </div>
        <div class="sms-actions">
          ${blockReason ? `<p class="sms-note sms-warn">${esc(blockReason)}</p>` : ''}
          <p class="sms-note">Queued means IPROG SMS accepted the message for processing. It does not confirm delivery to the handset.</p>
        </div>
        <div class="sms-log-wrap">
          ${logs.length ? `<table class="sms-log-table"><thead><tr>
            <th>Type</th><th>Dose</th><th>Date</th><th>Status</th><th>Phone</th><th>When</th>
          </tr></thead><tbody>
            ${logs.map(r => `<tr>
              <td>${esc(TYPE_LABEL[r.reminder_type] || r.reminder_type)}</td>
              <td>${esc(r.dose_label || '—')}</td>
              <td>${fmtDate(r.scheduled_date)}</td>
              <td>${statusBadge(r.status)}</td>
              <td>${esc(r.phone_masked || '—')}</td>
              <td>${esc(fmtWhen(r.sent_at || r.created_at))}</td>
            </tr>`).join('')}
          </tbody></table>` : '<p class="sms-note">No SMS logs yet for this patient.</p>'}
        </div>
      </div>
    `;
  }

  async function mount(hostId, patientId, episodeId) {
    try {
      const json = await load(patientId);
      if (json.success) renderSection(hostId, json, episodeId);
    } catch (err) {
      console.error('SMS status load error:', err);
    }
  }

  global.SmsReminders = { mount, load, renderSection };
})(window);
