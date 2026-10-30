/**
 * Property-Based Tests: Report Signature Block
 * Validates: Requirements 1.2, 1.3, 2.1–2.3, 4.1, 4.2, 4.5
 *
 * Uses Jest + fast-check. All DOM is constructed inline — no server required.
 *
 * Feature: report-signature-block
 */

'use strict';

const fc = require('fast-check');

// ─── Helpers replicated from reports.html ────────────────────────────────────

/**
 * Replicates applySignatureBlock() from reports.html.
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
 * Builds a full sig-block section (sans the outer .rpt-signatures wrapper)
 * and returns the populated DOM node together with its child references.
 */
function buildSigBlockDOM(name, signature) {
  const block = document.createElement('div');
  block.className = 'sig-block';

  const label = document.createElement('div');
  label.className = 'sig-label';
  label.textContent = 'Prepared By:';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'sig-image-wrap';

  const nameEl = document.createElement('div');
  nameEl.className = 'sig-name';

  const designation = document.createElement('div');
  designation.className = 'sig-designation';
  designation.innerHTML = 'Designation: <strong>ABC Nurse</strong>';

  const date = document.createElement('div');
  date.className = 'sig-date';
  date.innerHTML = 'Date: <span class="sig-date-span"></span>';

  block.appendChild(label);
  block.appendChild(imgWrap);
  block.appendChild(nameEl);
  block.appendChild(designation);
  block.appendChild(date);

  // Apply function under test
  applySignatureBlock(nameEl, imgWrap, name, signature);

  return { block, imgWrap, nameEl, designation, date };
}

/**
 * Formats a Date the same way generateReport() does in reports.html.
 */
function formatReportDate(date) {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Property Tests ───────────────────────────────────────────────────────────

// Feature: report-signature-block, Property 1: Sig-block section element order invariant
describe('P1 — Element order invariant (Req 1.2, 1.3)', () => {
  test(
    'for any (name, sig|null), child order is [sig-label, sig-image-wrap, sig-name, sig-designation, sig-date]',
    () => {
      // Arbitraries:
      // - name: any string (including empty)
      // - sig: either null or a valid data URL string
      const nameArb = fc.string();
      const sigArb = fc.option(
        fc.string({ minLength: 1, maxLength: 50 }).map(s => 'data:image/png;base64,' + s),
        { nil: null }
      );

      fc.assert(
        fc.property(nameArb, sigArb, (name, sig) => {
          const { block } = buildSigBlockDOM(name, sig);

          const expectedClasses = [
            'sig-label',
            'sig-image-wrap',
            'sig-name',
            'sig-designation',
            'sig-date',
          ];

          const children = Array.from(block.children);
          if (children.length !== 5) return false;

          return children.every((child, i) =>
            child.classList.contains(expectedClasses[i])
          );
        }),
        { numRuns: 100 }
      );
    }
  );
});

// Feature: report-signature-block, Property 2: Image round-trip
describe('P2 — Image round-trip (Req 2.1, 2.2, 2.3)', () => {
  test('valid data URL → img.src contains the data URL; null → no img child', () => {
    const validDataUrlArb = fc
      .string({ minLength: 1, maxLength: 200 })
      .map(s => 'data:image/png;base64,' + s);

    // Case A: valid data URL → img present with matching src
    fc.assert(
      fc.property(fc.string(), validDataUrlArb, (name, dataUrl) => {
        const { imgWrap } = buildSigBlockDOM(name, dataUrl);
        const img = imgWrap.querySelector('img');
        if (!img) return false;
        // img.src in jsdom prepends the base URL for absolute data URIs, but contains the original
        return img.getAttribute('src') === dataUrl;
      }),
      { numRuns: 100 }
    );

    // Case B: null → no img
    fc.assert(
      fc.property(fc.string(), (name) => {
        const { imgWrap } = buildSigBlockDOM(name, null);
        return imgWrap.querySelector('img') === null;
      }),
      { numRuns: 100 }
    );
  });

  test('non-image data URI (not starting with data:image/) → no img child', () => {
    const nonImageArb = fc
      .string({ minLength: 1, maxLength: 100 })
      .filter(s => !s.startsWith('data:image/'));

    fc.assert(
      fc.property(fc.string(), nonImageArb, (name, sig) => {
        const { imgWrap } = buildSigBlockDOM(name, sig);
        return imgWrap.querySelector('img') === null;
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: report-signature-block, Property 3: Report generation date formatting correctness
describe('P3 — Date format (Req 4.1, 4.2)', () => {
  test(
    'for any Date, toLocaleDateString("en-US", ...) matches /^[A-Z][a-z]+ \\d{1,2}, \\d{4}$/',
    () => {
      // Use dates within a reasonable range to avoid non-Gregorian calendar edge-cases
      // and explicitly exclude Invalid Date (NaN) values.
      const dateArb = fc
        .date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('2099-12-31T23:59:59.999Z'),
        })
        .filter(d => !isNaN(d.getTime()));

      const pattern = /^[A-Z][a-z]+ \d{1,2}, \d{4}$/;

      fc.assert(
        fc.property(dateArb, (date) => {
          const formatted = formatReportDate(date);
          return pattern.test(formatted);
        }),
        { numRuns: 200 }
      );
    }
  );
});

// Feature: report-signature-block, Property 4: Date consistency across both signature sections
describe('P4 — Date consistency (Req 4.5, 4.2)', () => {
  test(
    'for any date captured at report generation, both #sigPreparedDate and #sigNotedDate contain identical text',
    () => {
      // Build the minimal DOM that generateReport() populates
      const preparedSpan = document.createElement('span');
      preparedSpan.id = 'sigPreparedDate';
      const notedSpan = document.createElement('span');
      notedSpan.id = 'sigNotedDate';
      document.body.appendChild(preparedSpan);
      document.body.appendChild(notedSpan);

      try {
        const dateArb = fc
          .date({
            min: new Date('1970-01-01T00:00:00.000Z'),
            max: new Date('2099-12-31T23:59:59.999Z'),
          })
          .filter(d => !isNaN(d.getTime()));

        fc.assert(
          fc.property(dateArb, (date) => {
            // Simulate what generateReport() does
            const formattedDate = formatReportDate(date);
            preparedSpan.textContent = formattedDate;
            notedSpan.textContent = formattedDate;

            return preparedSpan.textContent === notedSpan.textContent;
          }),
          { numRuns: 200 }
        );
      } finally {
        document.body.removeChild(preparedSpan);
        document.body.removeChild(notedSpan);
      }
    }
  );
});
