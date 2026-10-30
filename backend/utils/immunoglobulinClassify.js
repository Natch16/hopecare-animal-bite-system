/**
 * Map Add Patient RIG selections to Quarterly Report HRIG / ERIG columns.
 *
 * ERIG: Equine Rabies Immunoglobulin (Equirab, Vinrab, category ERIG, rig_type Equine)
 * HRIG: Human Rabies Immunoglobulin (Berirab, category HRIG, rig_type Human)
 *
 * Blank / unselected values are not counted. One patient is not placed in both
 * columns unless equine AND human immunoglobulin were both actually recorded.
 */

function truthyFlag(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
  }
  return false;
}

function normalizeText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isErigText(v) {
  const t = normalizeText(v);
  if (!t) return false;
  if (/\bhrig\b/.test(t) || /human rabies/.test(t) || /\bberirab\b/.test(t)) return false;
  return (
    t === 'e' ||
    t === 'erig' ||
    t === 'equine' ||
    /\berig\b/.test(t) ||
    /equine/.test(t) ||
    /\bequirab\b/.test(t) ||
    /\bvinrab\b/.test(t)
  );
}

function isHrigText(v) {
  const t = normalizeText(v);
  if (!t) return false;
  if (/\berig\b/.test(t) || /equine/.test(t) || /\bequirab\b/.test(t) || /\bvinrab\b/.test(t)) {
    return false;
  }
  return (
    t === 'h' ||
    t === 'hrig' ||
    t === 'human' ||
    /\bhrig\b/.test(t) ||
    /human/.test(t) ||
    /\bberirab\b/.test(t)
  );
}

function classifyFromPatientFlags(p = {}) {
  const erig =
    truthyFlag(p.rig_equirab) ||
    truthyFlag(p.rig_vinrab) ||
    truthyFlag(p.rig_equine_given) ||
    isErigText(p.immunoglobulin) ||
    isErigText(p.immunoglobulin_type) ||
    isErigText(p.rig_type);

  const hrig =
    truthyFlag(p.rig_berirab) ||
    truthyFlag(p.rig_human_given) ||
    isHrigText(p.immunoglobulin) ||
    isHrigText(p.immunoglobulin_type) ||
    isHrigText(p.rig_type);

  return { erig, hrig };
}

function classifyFromRecord(r = {}) {
  if (!r) return { erig: false, hrig: false };
  const given = truthyFlag(r.rig_given);
  const hasType = Boolean(normalizeText(r.rig_type) || normalizeText(r.rig_brand) || normalizeText(r.category));
  if (!given && !hasType) return { erig: false, hrig: false };

  const erig =
    isErigText(r.rig_type) ||
    isErigText(r.rig_brand) ||
    isErigText(r.category) ||
    isErigText(r.vaccine_name);

  const hrig =
    isHrigText(r.rig_type) ||
    isHrigText(r.rig_brand) ||
    isHrigText(r.category) ||
    isHrigText(r.vaccine_name);

  return { erig, hrig };
}

function classifyImmunoglobulin(patientRow = {}, rigRecords = []) {
  const fromFlags = classifyFromPatientFlags(patientRow);
  let erig = fromFlags.erig;
  let hrig = fromFlags.hrig;
  const list = Array.isArray(rigRecords) ? rigRecords : [];
  for (const rec of list) {
    const c = classifyFromRecord(rec);
    erig = erig || c.erig;
    hrig = hrig || c.hrig;
  }
  return { erig, hrig };
}

function applyImmunoglobulinFlags(cases, records) {
  const byEpisode = new Map();
  const byPatient = new Map();
  for (const r of records || []) {
    const cls = classifyFromRecord(r);
    if (!cls.erig && !cls.hrig) continue;
    if (r.episode_id != null) {
      const prev = byEpisode.get(Number(r.episode_id)) || { erig: false, hrig: false };
      byEpisode.set(Number(r.episode_id), {
        erig: prev.erig || cls.erig,
        hrig: prev.hrig || cls.hrig,
      });
    }
    if (r.patient_id != null) {
      const prev = byPatient.get(Number(r.patient_id)) || { erig: false, hrig: false };
      byPatient.set(Number(r.patient_id), {
        erig: prev.erig || cls.erig,
        hrig: prev.hrig || cls.hrig,
      });
    }
  }

  for (const c of cases || []) {
    const fromFlags = classifyFromPatientFlags(c);
    const fromRec = (c.episode_id != null && byEpisode.get(Number(c.episode_id)))
      || { erig: false, hrig: false };
    const fromPatientRec = byPatient.get(Number(c.patient_id)) || { erig: false, hrig: false };
    c._erig = fromFlags.erig || fromRec.erig || fromPatientRec.erig;
    c._hrig = fromFlags.hrig || fromRec.hrig || fromPatientRec.hrig;
  }
  return cases;
}

module.exports = {
  truthyFlag,
  classifyFromPatientFlags,
  classifyFromRecord,
  classifyImmunoglobulin,
  applyImmunoglobulinFlags,
};
