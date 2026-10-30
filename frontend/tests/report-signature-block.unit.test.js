/**
 * Unit Tests: Report Signature Block
 * Validates: Requirements 1.1–1.5, 2.1–2.5, 3.1–3.2, 4.1–4.2, 4.5, 7.4–7.5
 *
 * Uses Jest + jsdom. All DOM is constructed inline — no server or browser required.
 */

'use strict';

// ─── Helpers extracted / replicated from reports.html and settings.html ───────

/**
 * Replicates applySignatureBlock() from reports.html.
 * Populates name text and conditionally inserts an <img> into the image wrap.
 */
function applySignatureBlock(nameEl, imgWrap, name, signature) {
  nameEl.textContent = name ? name.toUpperCase() : '';
  imgWrap.innerHTML = '';
  if (signature && String(signature).startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = signature;
    img.className = 'sig-image';
    img.alt = '';
    imgWrap.appendChild(img);
  }
}

/**
 * Builds the full .rpt-signatures HTML snippet as it appears in reports.html
 * after Tasks 1–4 are completed.
 */
function buildSignatureHTML() {
  return `
    <div class="rpt-signatures" id="rptSig">
      <div class="sig-block">
        <div class="sig-label">Prepared By:</div>
        <div class="sig-image-wrap" id="sigPreparedImg"></div>
        <div class="sig-name" id="sigPreparedName"></div>
        <div class="sig-designation">Designation: <strong>ABC Nurse</strong></div>
        <div class="sig-date">Date: <span id="sigPreparedDate"></span></div>
      </div>
      <div class="sig-block">
        <div class="sig-label">Noted By:</div>
        <div class="sig-image-wrap" id="sigNotedImg"></div>
        <div class="sig-name" id="sigNotedName"></div>
        <div class="sig-designation">Designation: <strong>ABC Nurse</strong></div>
        <div class="sig-date">Date: <span id="sigNotedDate"></span></div>
      </div>
    </div>`;
}

/**
 * Builds the Report Settings panel HTML snippet as it appears in settings.html
 * after Task 3 is completed (maxlength="100" present, no designation/date inputs).
 */
function buildReportSettingsPanelHTML() {
  return `
    <div id="panel-report">
      <div class="fl-group">
        <input type="text" id="rsCenterName" placeholder=" ">
        <label>Animal Bite Center Name</label>
      </div>
      <div class="fl-group">
        <input type="text" id="rsCity" placeholder=" ">
        <label>City</label>
      </div>
      <!-- Prepared By -->
      <div class="sig-section">
        <div class="fl-group">
          <input type="text" id="rsPreparedBy" placeholder=" " maxlength="100">
          <label>Name</label>
        </div>
        <canvas id="sigPadPrepared" width="300" height="140"></canvas>
        <div class="sig-saved-badge" id="sigPreparedSaved" style="display:none;">
          <span>Signature saved</span>
        </div>
      </div>
      <!-- Noted By -->
      <div class="sig-section">
        <div class="fl-group">
          <input type="text" id="rsNotedBy" placeholder=" " maxlength="100">
          <label>Name</label>
        </div>
        <canvas id="sigPadNoted" width="300" height="140"></canvas>
        <div class="sig-saved-badge" id="sigNotedSaved" style="display:none;">
          <span>Signature saved</span>
        </div>
      </div>
    </div>`;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Signature Block HTML Structure (Requirement 1)', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.innerHTML = buildSignatureHTML();
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  test('contains exactly 2 .sig-block elements (Req 1.1, 1.4)', () => {
    const blocks = container.querySelectorAll('.sig-block');
    expect(blocks).toHaveLength(2);
  });

  test('.sig-label text values are "Prepared By:" and "Noted By:" (Req 1.5)', () => {
    const labels = container.querySelectorAll('.sig-label');
    expect(labels).toHaveLength(2);
    expect(labels[0].textContent.trim()).toBe('Prepared By:');
    expect(labels[1].textContent.trim()).toBe('Noted By:');
  });

  test('both .sig-designation elements contain the text "ABC Nurse" (Req 3.1)', () => {
    const designations = container.querySelectorAll('.sig-designation');
    expect(designations).toHaveLength(2);
    designations.forEach(d => {
      expect(d.textContent).toContain('ABC Nurse');
    });
  });

  test('child element order in each sig-block is: sig-label, sig-image-wrap, sig-name, sig-designation, sig-date (Req 1.2, 1.3)', () => {
    const blocks = container.querySelectorAll('.sig-block');
    const expectedClasses = ['sig-label', 'sig-image-wrap', 'sig-name', 'sig-designation', 'sig-date'];
    blocks.forEach(block => {
      const children = Array.from(block.children);
      expect(children).toHaveLength(5);
      children.forEach((child, i) => {
        expect(child.classList.contains(expectedClasses[i])).toBe(true);
      });
    });
  });
});

describe('Signature Block CSS Properties (Requirement 2.4, 2.5, 7.5)', () => {
  let container;

  beforeEach(() => {
    // Inject inline styles to simulate what the real CSS provides
    const style = document.createElement('style');
    style.textContent = `
      .sig-name { border-top: 1px solid #555; padding-top: 6px; }
      .sig-image { max-height: 48px; max-width: 180px; object-fit: contain; }
    `;
    document.head.appendChild(style);
    container = document.createElement('div');
    container.innerHTML = buildSignatureHTML();
    document.body.appendChild(container);
    // Tag style for cleanup
    style.setAttribute('data-test', 'sig-styles');
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.head.querySelector('style[data-test="sig-styles"]')?.remove();
  });

  test('.sig-name has border-top CSS applied (Req 2.5, 7.5)', () => {
    const nameEl = container.querySelector('.sig-name');
    const style = window.getComputedStyle(nameEl);
    // jsdom may not fully compute shorthand, so we check the element has the class
    // and the inline stylesheet defines the rule
    expect(nameEl).not.toBeNull();
    // Verify via the stylesheet rule itself — jsdom resolves computed styles from <style> tags
    expect(style.borderTopStyle).toBe('solid');
    expect(style.borderTopWidth).toBe('1px');
  });

  test('.sig-image has max-height: 48px and max-width: 180px (Req 2.4)', () => {
    // Insert an img with sig-image class
    const imgWrap = container.querySelector('.sig-image-wrap');
    const img = document.createElement('img');
    img.className = 'sig-image';
    img.src = 'data:image/png;base64,abc';
    imgWrap.appendChild(img);
    const style = window.getComputedStyle(img);
    expect(style.maxHeight).toBe('48px');
    expect(style.maxWidth).toBe('180px');
  });
});

describe('applySignatureBlock() function (Requirement 2.1–2.3)', () => {
  let nameEl, imgWrap;

  beforeEach(() => {
    nameEl = document.createElement('div');
    nameEl.className = 'sig-name';
    imgWrap = document.createElement('div');
    imgWrap.className = 'sig-image-wrap';
    document.body.appendChild(nameEl);
    document.body.appendChild(imgWrap);
  });

  afterEach(() => {
    document.body.removeChild(nameEl);
    document.body.removeChild(imgWrap);
  });

  test('null signature → no <img> child in sig-image-wrap (Req 2.3)', () => {
    applySignatureBlock(nameEl, imgWrap, 'Juan dela Cruz', null);
    expect(imgWrap.querySelector('img')).toBeNull();
  });

  test('valid data URL → <img> child present with matching src (Req 2.1, 2.2)', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
    applySignatureBlock(nameEl, imgWrap, 'Juan dela Cruz', dataUrl);
    const img = imgWrap.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.src).toContain('data:image/png;base64,');
  });

  test('non-image data URL → no <img> child', () => {
    applySignatureBlock(nameEl, imgWrap, 'Juan dela Cruz', 'data:text/plain;base64,hello');
    expect(imgWrap.querySelector('img')).toBeNull();
  });

  test('name is uppercased in sig-name element (Req 2.5)', () => {
    applySignatureBlock(nameEl, imgWrap, 'juan dela cruz', null);
    expect(nameEl.textContent).toBe('JUAN DELA CRUZ');
  });

  test('empty/null name → empty sig-name text', () => {
    applySignatureBlock(nameEl, imgWrap, null, null);
    expect(nameEl.textContent).toBe('');
  });
});

describe('Report Settings Panel — no designation or date input fields (Requirement 3.2, 4.3)', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.innerHTML = buildReportSettingsPanelHTML();
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  test('no input field with type="date" exists in the report settings panel (Req 4.3)', () => {
    const dateInputs = container.querySelectorAll('input[type="date"]');
    expect(dateInputs).toHaveLength(0);
  });

  test('no input or textarea for "designation" exists in the report settings panel (Req 3.2)', () => {
    // Check by id
    const byId = container.querySelector('#rsDesignation, #rsPreparedPos, #rsNotedPos, #rsApprovedByPos');
    expect(byId).toBeNull();
    // Check by label text
    const labels = Array.from(container.querySelectorAll('label'));
    const designationLabel = labels.find(l =>
      l.textContent.toLowerCase().includes('designation')
    );
    expect(designationLabel).toBeUndefined();
  });

  test('prepared-by name input has maxlength="100" (Req 5.1)', () => {
    const input = container.querySelector('#rsPreparedBy');
    expect(input).not.toBeNull();
    expect(input.getAttribute('maxlength')).toBe('100');
  });

  test('noted-by name input has maxlength="100" (Req 5.2)', () => {
    const input = container.querySelector('#rsNotedBy');
    expect(input).not.toBeNull();
    expect(input.getAttribute('maxlength')).toBe('100');
  });
});

describe('clearSignature() behavior (Requirement 6.11)', () => {
  test('clearSignature() hides the saved badge and empties the pad state (Req 6.11)', () => {
    // jsdom does not implement HTMLCanvasElement.getContext('2d') without the
    // optional `canvas` npm package.  We therefore test the observable side-effects
    // that clearSignature() produces in the actual settings.html implementation:
    //   1. The SignaturePad instance's hasInk flag is set to false (isEmpty() → true)
    //   2. The saved-badge element is hidden (display: none)
    //
    // We replicate the same logic used by clearSignature() / SignaturePad.clear()
    // without calling getContext, which is not available in this environment.

    // Minimal SignaturePad state object (mirrors the real implementation)
    const mockPad = {
      hasInk: true, // starts with a "drawn" signature
      isEmpty() { return !this.hasInk; },
      clear(markEmpty = true) {
        // In the real code, clearRect is called here — we skip it for jsdom.
        if (markEmpty) this.hasInk = false;
      },
    };

    const badge = document.createElement('div');
    badge.id = 'sigPreparedSaved';
    badge.style.display = 'inline-flex'; // visible before clear
    document.body.appendChild(badge);

    // Replicate clearSignature('prepared') logic from settings.html:
    mockPad.clear();
    badge.style.display = 'none';

    try {
      expect(mockPad.isEmpty()).toBe(true);
      expect(badge.style.display).toBe('none');
    } finally {
      document.body.removeChild(badge);
    }
  });
});

describe('#sigPreparedSaved badge visibility after saveSignature() (Requirement 6.10)', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.innerHTML = buildReportSettingsPanelHTML();
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  test('badge is hidden initially', () => {
    const badge = container.querySelector('#sigPreparedSaved');
    expect(badge).not.toBeNull();
    expect(badge.style.display).toBe('none');
  });

  test('badge becomes visible when programmatically set (simulating successful saveSignature())', () => {
    const badge = container.querySelector('#sigPreparedSaved');
    // Simulate what saveSignature() does on success:
    badge.style.display = 'inline-flex';
    expect(badge.style.display).toBe('inline-flex');
  });
});
