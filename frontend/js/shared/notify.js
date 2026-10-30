(function (global) {
  const ICONS = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
  };
  const TITLES = {
    success: 'Success',
    error: 'Unable to complete',
    warning: 'Please review',
    info: 'Notice',
  };
  const TECHNICAL = /localhost|127\.0\.0\.1|0\.0\.0\.0|:\d{2,5}\/|Column '|ER_[A-Z_]+|SQL|sqlMessage|ECONNREFUSED|cannot be null|Duplicate entry|Failed to fetch|NetworkError|TypeError|ReferenceError|Unexpected token|stack|mysql|sqlite|ENOENT/i;

  function isTechnical(message) {
    const text = String(message || '');
    return !text.trim() || text.length > 220 || TECHNICAL.test(text);
  }

  function safeMessage(message, fallback) {
    const text = String(message || '').trim();
    if (isTechnical(text)) return fallback || 'The inventory update could not be completed. Please check your entries.';
    return text;
  }

  function fromStatus(status, body, fallbacks) {
    const fb = fallbacks || {};
    if (status === 401) return fb.auth || 'Please sign in again to continue.';
    if (status === 403) return fb.forbidden || 'You do not have permission to complete this action.';
    if (status === 400 || status === 409 || status === 422) {
      return safeMessage(body && body.message, fb.validation || 'Please review the inventory values before saving.');
    }
    if (!status || status >= 500) {
      return fb.server || 'The system is temporarily unavailable. Please try again later.';
    }
    return safeMessage(body && body.message, fb.error || 'The inventory update could not be completed. Please check your entries.');
  }

  async function parseApi(response, fallbacks) {
    const fb = fallbacks || {};
    let body = {};
    try { body = await response.json(); } catch (_) { body = {}; }
    if (response.ok && body && body.success !== false) {
      return {
        ok: true,
        data: body.data,
        message: fb.success || safeMessage(body.message, 'Inventory record saved successfully.'),
        body,
      };
    }
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('Inventory request failed', response && response.status, body);
    }
    return {
      ok: false,
      data: null,
      message: fromStatus(response && response.status, body, fb),
      body,
    };
  }

  function ensureStack() {
    let stack = document.getElementById('remisToastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'remisToastStack';
      stack.className = 'remis-toast-stack';
      stack.setAttribute('aria-live', 'polite');
      stack.setAttribute('aria-relevant', 'additions');
      document.body.appendChild(stack);
    }
    return stack;
  }

  let lastKey = '';
  let lastAt = 0;

  function toast(message, type) {
    const kind = ICONS[type] ? type : 'info';
    const text = safeMessage(message, kind === 'success'
      ? 'Inventory record saved successfully.'
      : kind === 'warning'
        ? 'Please review the inventory values before saving.'
        : 'The inventory update could not be completed. Please check your entries.');
    const now = Date.now();
    const key = kind + ':' + text;
    if (key === lastKey && now - lastAt < 1600) return;
    lastKey = key;
    lastAt = now;

    const stack = ensureStack();
    const el = document.createElement('div');
    el.className = 'remis-toast remis-toast-' + kind;
    el.setAttribute('role', kind === 'error' || kind === 'warning' ? 'alert' : 'status');
    el.innerHTML =
      '<span class="remis-toast-icon"><i class="fa-solid ' + ICONS[kind] + '"></i></span>' +
      '<div class="remis-toast-copy"><strong>' + TITLES[kind] + '</strong><p></p></div>' +
      '<button type="button" class="remis-toast-close" aria-label="Dismiss notification"><i class="fa-solid fa-xmark"></i></button>';
    el.querySelector('p').textContent = text;
    const close = () => {
      el.classList.add('remis-toast-out');
      setTimeout(() => el.remove(), 220);
    };
    el.querySelector('.remis-toast-close').addEventListener('click', close);
    stack.appendChild(el);
    setTimeout(close, kind === 'error' ? 6400 : 4200);
  }

  function ensureConfirm() {
    let modal = document.getElementById('remisConfirmModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'remisConfirmModal';
    modal.className = 'adm-modal remis-confirm-modal';
    modal.innerHTML =
      '<div class="adm-modal-box remis-confirm-box" role="dialog" aria-modal="true" aria-labelledby="remisConfirmTitle">' +
      '<div class="remis-confirm-icon"><i class="fa-solid fa-circle-question"></i></div>' +
      '<h3 id="remisConfirmTitle">Confirm action</h3>' +
      '<p id="remisConfirmBody"></p>' +
      '<div class="remis-confirm-actions">' +
      '<button type="button" class="adm-btn adm-btn-secondary" id="remisConfirmCancel">Cancel</button>' +
      '<button type="button" class="adm-btn adm-btn-primary" id="remisConfirmOk">Confirm</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    return modal;
  }

  function confirmAction(opts) {
    const options = opts || {};
    const modal = ensureConfirm();
    const title = modal.querySelector('#remisConfirmTitle');
    const body = modal.querySelector('#remisConfirmBody');
    const okBtn = modal.querySelector('#remisConfirmOk');
    const cancelBtn = modal.querySelector('#remisConfirmCancel');
    title.textContent = options.title || 'Confirm action';
    body.textContent = options.body || 'Do you want to continue?';
    okBtn.textContent = options.confirmLabel || 'Confirm';
    cancelBtn.textContent = options.cancelLabel || 'Cancel';
    okBtn.className = 'adm-btn ' + (options.danger ? 'adm-btn-danger' : 'adm-btn-primary');
    modal.classList.add('open');
    return new Promise((resolve) => {
      const done = (value) => {
        modal.classList.remove('open');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        modal.onclick = null;
        resolve(value);
      };
      okBtn.onclick = () => done(true);
      cancelBtn.onclick = () => done(false);
      modal.onclick = (ev) => { if (ev.target === modal) done(false); };
    });
  }

  let loadingCount = 0;
  function setLoading(on, label) {
    let bar = document.getElementById('remisLoadingBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'remisLoadingBar';
      bar.className = 'remis-loading-bar';
      bar.innerHTML = '<span></span><em id="remisLoadingLabel">Saving…</em>';
      document.body.appendChild(bar);
    }
    loadingCount += on ? 1 : (loadingCount > 0 ? -1 : 0);
    const caption = document.getElementById('remisLoadingLabel');
    if (caption && label) caption.textContent = label;
    bar.classList.toggle('show', loadingCount > 0);
  }

  global.RemisNotify = {
    toast,
    confirmAction,
    parseApi,
    fromStatus,
    safeMessage,
    isTechnical,
    setLoading,
  };
  global.toast = function (msg, ok) {
    const type = ok === false || ok === 'error' ? 'error'
      : ok === 'warning' ? 'warning'
        : ok === 'info' ? 'info'
          : 'success';
    toast(msg, type);
  };
})(window);
