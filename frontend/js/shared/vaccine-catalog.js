/**
 * Shared Vaccine Management catalog for Add Patient Record and New Case.
 * Brands and Cat III options are loaded from the database — not hardcoded.
 */
(function (global) {
  const DEFAULT_TETANUS = ['TT', 'ATS', 'HTIG'];
  const DEFAULT_ERIG = ['Equirab', 'Vinrab'];
  const DEFAULT_HRIG = ['Berirab'];
  const FORM_LABELS = { TT: 'Tetanus-Toxoid' };

  const catalog = {
    antiRabies: [],
    tetanus: [],
    erig: [],
    hrig: [],
    loaded: false,
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function displayName(v) {
    if (!v) return '';
    if (FORM_LABELS[v.name]) return FORM_LABELS[v.name];
    const conc = v.concentration && !String(v.name).includes(v.concentration)
      ? ` (${v.concentration})`
      : '';
    return `${v.name}${conc}`;
  }

  function extras(list, defaults) {
    return (list || []).filter((v) => !defaults.includes(v.name));
  }

  function isAvailable(list, name) {
    return (list || []).some((v) => v.name === name);
  }

  function setVisible(el, show) {
    if (!el) return;
    el.style.display = show ? '' : 'none';
  }

  async function load() {
    try {
      const res = await fetch('/api/settings/vaccines/catalog', { credentials: 'include' });
      const json = await res.json();
      if (!json.success || !json.data) return catalog;
      catalog.antiRabies = json.data.antiRabies || [];
      catalog.tetanus = json.data.tetanus || [];
      catalog.erig = json.data.erig || [];
      catalog.hrig = json.data.hrig || [];
      catalog.loaded = true;
    } catch (e) {
      console.warn('Vaccine catalog load error:', e);
    }
    return catalog;
  }

  function fillBrandSelect(selectId, currentValue) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const current = currentValue != null ? String(currentValue) : (sel.value || '');
    const brands = catalog.antiRabies.slice();
    if (current && !brands.some((v) => v.name === current)) {
      brands.unshift({ name: current, vaccine_id: 0 });
    }
    sel.innerHTML = '<option value="">Select</option>' + brands.map((v) =>
      `<option value="${esc(v.name)}">${esc(v.name)}</option>`
    ).join('');
    if (current) sel.value = current;
  }

  function applyDefaultVisibility(prefix) {
    const p = prefix || '';
    const ttBlock = document.getElementById(p + 'ttBlock')
      || document.getElementById(p + 'ttGiven')?.closest('.cat3-subblock, .cat3-box');
    const atsBlock = document.getElementById(p + 'atsBlock')
      || document.getElementById(p + 'atsGiven')?.closest('.cat3-subblock, .cat3-box');
    const htigBlock = document.getElementById(p + 'htigBlock')
      || document.getElementById(p + 'htigGiven')?.closest('.cat3-subblock, .cat3-box');
    setVisible(ttBlock, isAvailable(catalog.tetanus, 'TT'));
    setVisible(atsBlock, isAvailable(catalog.tetanus, 'ATS'));
    setVisible(htigBlock, isAvailable(catalog.tetanus, 'HTIG'));

    const tt = catalog.tetanus.find((v) => v.name === 'TT');
    const ats = catalog.tetanus.find((v) => v.name === 'ATS');
    const htig = catalog.tetanus.find((v) => v.name === 'HTIG');
    const ttLabel = document.querySelector(`label[for="${p}ttGiven"], #${p}ttGiven`)?.parentElement;
    if (tt && ttLabel && ttLabel.tagName === 'LABEL') {
      const box = document.getElementById(p + 'ttGiven');
      ttLabel.innerHTML = '';
      if (box) ttLabel.appendChild(box);
      ttLabel.appendChild(document.createTextNode(' ' + displayName(tt)));
    } else if (tt) {
      const lab = document.getElementById(p + 'ttGiven')?.closest('label');
      if (lab) {
        const box = document.getElementById(p + 'ttGiven');
        lab.innerHTML = '';
        if (box) lab.appendChild(box);
        lab.appendChild(document.createTextNode(' ' + displayName(tt)));
      }
    }
    if (ats) {
      const lab = document.getElementById(p + 'atsGiven')?.closest('label');
      if (lab) {
        const box = document.getElementById(p + 'atsGiven');
        lab.innerHTML = '';
        if (box) lab.appendChild(box);
        lab.appendChild(document.createTextNode(' ' + displayName(ats)));
      }
    }
    if (htig) {
      const lab = document.getElementById(p + 'htigGiven')?.closest('label');
      if (lab) {
        const box = document.getElementById(p + 'htigGiven');
        lab.innerHTML = '';
        if (box) lab.appendChild(box);
        lab.appendChild(document.createTextNode(' ' + displayName(htig)));
      }
    }

    applyTetanusOptionalFields(p);

    const erigDefaults = [
      { name: 'Equirab', id: p + 'rigEquirab' },
      { name: 'Vinrab', id: p + 'rigVinrab' },
    ];
    erigDefaults.forEach(({ name, id }) => {
      const el = document.getElementById(id);
      const wrap = el ? el.closest('label') : null;
      setVisible(wrap, isAvailable(catalog.erig, name));
      const v = catalog.erig.find((x) => x.name === name);
      if (v && wrap) {
        wrap.innerHTML = '';
        wrap.appendChild(el);
        wrap.appendChild(document.createTextNode(' ' + displayName(v)));
      }
    });
    const ber = document.getElementById(p + 'rigBerirab');
    const berWrap = ber ? ber.closest('label') : null;
    setVisible(berWrap, isAvailable(catalog.hrig, 'Berirab'));
    const berV = catalog.hrig.find((x) => x.name === 'Berirab');
    if (berV && berWrap) {
      berWrap.innerHTML = '';
      berWrap.appendChild(ber);
      berWrap.appendChild(document.createTextNode(' ' + displayName(berV)));
    }
  }

  function extraTetanus() {
    return extras(catalog.tetanus, DEFAULT_TETANUS);
  }

  function extraErig() {
    return extras(catalog.erig, DEFAULT_ERIG);
  }

  function extraHrig() {
    return extras(catalog.hrig, DEFAULT_HRIG);
  }

  function applyTetanusOptionalFields(prefix) {
    const p = prefix || '';
    if (!catalog.loaded) {
      setVisible(document.getElementById(p + 'ttRouteRow'), false);
      setVisible(document.getElementById(p + 'ttAnstRow'), false);
      setVisible(document.getElementById(p + 'atsRouteRow'), false);
      setVisible(document.getElementById(p + 'atsAnstRow'), true);
      setVisible(document.getElementById(p + 'htigRouteRow'), true);
      setVisible(document.getElementById(p + 'htigAnstRow'), false);
      return;
    }
    const keys = [
      { name: 'TT', id: 'tt' },
      { name: 'ATS', id: 'ats' },
      { name: 'HTIG', id: 'htig' },
    ];
    keys.forEach(({ name, id }) => {
      const v = (catalog.tetanus || []).find((x) => x.name === name);
      setVisible(document.getElementById(p + id + 'RouteRow'), fieldEnabled(v, 'has_route', false));
      setVisible(document.getElementById(p + id + 'AnstRow'), fieldEnabled(v, 'has_anst', false));
    });
  }

  function fieldEnabled(v, key, defaultOn) {
    if (!v || v[key] === undefined || v[key] === null) return defaultOn;
    return Number(v[key]) === 1;
  }

  function tetanusFieldInputs(v, pfx) {
    const wrap = (label, inputHtml) => `<div class="form-group"><label>${label}</label>${inputHtml}</div>`;
    const cells = [
      wrap('Dose (mL)', `<input type="number" id="${pfx}dose_ml" min="0" step="0.01" placeholder="0.00" value="${v.default_dose_ml != null ? v.default_dose_ml : ''}">`),
      wrap('Injection Site', `<input type="text" id="${pfx}injection_site" placeholder="e.g. deltoid" value="${esc(v.default_injection_site || '')}">`),
      wrap('Date Given', `<input type="date" id="${pfx}date_given">`),
      wrap('Given By', `<input type="text" id="${pfx}given_by" placeholder="Staff name">`),
    ];
    const row = `<div class="form-row" id="${pfx}fields" style="display:grid;">${cells.join('')}</div>`;
    const routeRow = fieldEnabled(v, 'has_route', false)
      ? `<div class="cat3-route-row" id="${pfx}routeRow">
           <span>Route:</span>
           <label><input type="radio" name="${pfx}route" id="${pfx}routeId" value="ID"> ID</label>
           <label><input type="radio" name="${pfx}route" id="${pfx}routeIm" value="IM"> IM</label>
         </div>`
      : '';
    const anstRow = fieldEnabled(v, 'has_anst', false)
      ? `<div class="cat3-route-row" id="${pfx}anstRow">
           <span>ANST Result:</span>
           <label><input type="radio" name="${pfx}anst" id="${pfx}anstPos" value="Positive"> Positive (+)</label>
           <label><input type="radio" name="${pfx}anst" id="${pfx}anstNeg" value="Negative"> Negative (−)</label>
         </div>`
      : '';
    return { row, routeRow, anstRow };
  }

  function renderExtraTetanus(containerId, idPrefix) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const list = extraTetanus();
    if (!list.length) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = list.map((v) => {
      const pfx = idPrefix + 'dynvax_' + v.vaccine_id + '_';
      const parts = tetanusFieldInputs(v, pfx);
      return `<div class="cat3-subblock" id="${pfx}block">
        <label class="cat3-check-label">
          <input type="checkbox" id="${pfx}given">
          ${esc(displayName(v))}
        </label>
        ${parts.row}${parts.routeRow}${parts.anstRow}
      </div>`;
    }).join('');
  }

  function renderExtraRig(containerId, idPrefix, category) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const list = category === 'HRIG' ? extraHrig() : extraErig();
    if (!list.length) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = list.map((v) => {
      const id = idPrefix + 'dynrig_' + v.vaccine_id;
      return `<label class="cat3-check-label"><input type="checkbox" id="${id}" data-vaccine-id="${v.vaccine_id}" data-vaccine-name="${esc(v.name)}" data-category="${esc(v.category)}" data-concentration="${esc(v.concentration || '')}"> ${esc(displayName(v))}</label>`;
    }).join('');
  }

  function toggleDynFields(pfx) {
    // Treatment fields stay visible like TT / ATS / HTIG, whether or not the vaccine is checked.
  }

  function collectDynamicTetanus(idPrefix) {
    return extraTetanus()
      .filter((v) => document.getElementById(idPrefix + 'dynvax_' + v.vaccine_id + '_given')?.checked)
      .map((v) => {
        const pfx = idPrefix + 'dynvax_' + v.vaccine_id + '_';
        const getRadio = (name) => {
          const checked = document.querySelector(`input[name="${pfx}${name}"]:checked`);
          return checked ? checked.value : null;
        };
        return {
          vaccine_id: v.vaccine_id,
          vaccine_name: v.name,
          given: 1,
          dose_ml: parseFloat(document.getElementById(pfx + 'dose_ml')?.value) || null,
          injection_site: document.getElementById(pfx + 'injection_site')?.value?.trim() || null,
          date_given: document.getElementById(pfx + 'date_given')?.value || null,
          given_by: document.getElementById(pfx + 'given_by')?.value?.trim() || null,
          route: fieldEnabled(v, 'has_route', false) ? getRadio('route') : null,
          anst_result: fieldEnabled(v, 'has_anst', false) ? getRadio('anst') : null,
        };
      });
  }

  function collectDynamicRig(idPrefix, volumeFields) {
    const out = [];
    extraErig().forEach((v) => {
      const el = document.getElementById(idPrefix + 'dynrig_' + v.vaccine_id);
      if (!el || !el.checked) return;
      out.push({
        vaccine_id: v.vaccine_id,
        vaccine_name: v.name,
        category: 'ERIG',
        rig_type: 'Equine',
        given: 1,
        concentration: v.concentration || '200 IU/mL',
        volume_ml: volumeFields?.equineMl || null,
        anst_result: null,
        date_given: volumeFields?.equineDate || null,
        given_by: volumeFields?.equineBy || null,
      });
    });
    extraHrig().forEach((v) => {
      const el = document.getElementById(idPrefix + 'dynrig_' + v.vaccine_id);
      if (!el || !el.checked) return;
      out.push({
        vaccine_id: v.vaccine_id,
        vaccine_name: v.name,
        category: 'HRIG',
        rig_type: 'Human',
        given: 1,
        concentration: v.concentration || '300 IU/mL',
        volume_ml: volumeFields?.humanMl || null,
        anst_result: null,
        date_given: volumeFields?.humanDate || null,
        given_by: volumeFields?.humanBy || null,
      });
    });
    return out;
  }

  function toInputDate(val) {
    if (!val) return '';
    if (typeof dateOnlyIso === 'function') return dateOnlyIso(val);
    const s = String(val);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  }

  function populateDynamicTetanus(idPrefix, records) {
    const rows = Array.isArray(records) ? records : [];
    extraTetanus().forEach((v) => {
      const rec = rows.find((r) =>
        Number(r.vaccine_id) === Number(v.vaccine_id)
        || (r.vaccine_name && String(r.vaccine_name).toLowerCase() === String(v.name).toLowerCase())
      );
      if (!rec) return;
      const pfx = idPrefix + 'dynvax_' + v.vaccine_id + '_';
      const chk = document.getElementById(pfx + 'given');
      if (chk) chk.checked = rec.given == null ? true : Number(rec.given) === 1;
      const dose = document.getElementById(pfx + 'dose_ml');
      if (dose) dose.value = rec.dose_ml ?? v.default_dose_ml ?? '';
      const site = document.getElementById(pfx + 'injection_site');
      if (site) site.value = rec.injection_site || '';
      const dateEl = document.getElementById(pfx + 'date_given');
      if (dateEl) dateEl.value = toInputDate(rec.date_given);
      const by = document.getElementById(pfx + 'given_by');
      if (by) by.value = rec.given_by || '';
      if (rec.route === 'ID') {
        const el = document.getElementById(pfx + 'routeId');
        if (el) el.checked = true;
      } else if (rec.route === 'IM') {
        const el = document.getElementById(pfx + 'routeIm');
        if (el) el.checked = true;
      }
      if (rec.anst_result === 'Positive') {
        const el = document.getElementById(pfx + 'anstPos');
        if (el) el.checked = true;
      } else if (rec.anst_result === 'Negative') {
        const el = document.getElementById(pfx + 'anstNeg');
        if (el) el.checked = true;
      }
    });
  }

  function resetDynamic(idPrefix) {
    extraTetanus().forEach((v) => {
      const pfx = idPrefix + 'dynvax_' + v.vaccine_id + '_';
      const chk = document.getElementById(pfx + 'given');
      if (chk) chk.checked = false;
      ['dose_ml', 'injection_site', 'date_given', 'given_by'].forEach((f) => {
        const el = document.getElementById(pfx + f);
        if (el) el.value = '';
      });
      document.querySelectorAll(`input[name="${pfx}route"], input[name="${pfx}anst"]`)
        .forEach((r) => { r.checked = false; });
    });
    [...extraErig(), ...extraHrig()].forEach((v) => {
      const el = document.getElementById(idPrefix + 'dynrig_' + v.vaccine_id);
      if (el) el.checked = false;
    });
  }

  function extraErigChecked(idPrefix) {
    return extraErig().some((v) => document.getElementById(idPrefix + 'dynrig_' + v.vaccine_id)?.checked);
  }

  function extraHrigChecked(idPrefix) {
    return extraHrig().some((v) => document.getElementById(idPrefix + 'dynrig_' + v.vaccine_id)?.checked);
  }

  function isValidBrand(value) {
    if (!value) return 'Invalid vaccine brand.';
    if (!catalog.loaded) {
      if (['Abhayrab', 'Vaxirab'].includes(value)) return null;
    }
    if (catalog.antiRabies.some((v) => v.name === value)) return null;
    return 'Invalid vaccine brand. Select an Anti-Rabies Vaccine from Vaccine Management.';
  }

  function applyToPatientForm(currentBrand) {
    fillBrandSelect('brandName', currentBrand);
    applyDefaultVisibility('');
    renderExtraTetanus('dynamicTetanusVaccines', '');
    renderExtraRig('dynamicErigVaccines', '', 'ERIG');
    renderExtraRig('dynamicHrigVaccines', '', 'HRIG');
  }

  function applyToNewCaseForm(currentBrand) {
    fillBrandSelect('nc_brandName', currentBrand);
    applyDefaultVisibility('nc_');
    renderExtraTetanus('nc_dynamicTetanusVaccines', 'nc_');
    renderExtraRig('nc_dynamicErigVaccines', 'nc_', 'ERIG');
    renderExtraRig('nc_dynamicHrigVaccines', 'nc_', 'HRIG');
  }

  global.VaccineCatalog = {
    catalog,
    load,
    fillBrandSelect,
    applyDefaultVisibility,
    renderExtraTetanus,
    renderExtraRig,
    toggleDynFields,
    collectDynamicTetanus,
    collectDynamicRig,
    populateDynamicTetanus,
    resetDynamic,
    extraErigChecked,
    extraHrigChecked,
    extraTetanus,
    isValidBrand,
    applyToPatientForm,
    applyToNewCaseForm,
    displayName,
  };
})(window);
