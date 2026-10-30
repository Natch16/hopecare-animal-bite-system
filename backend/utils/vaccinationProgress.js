'use strict';

/**
 * Classifies patient vaccination schedules from the vaccine_d0/d3/d7 columns.
 * A schedule is completed once D0, D3 and D7 are all recorded.
 */
function classifyVaccinationSchedules(rows, now = new Date()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const weekFromNow = new Date(today); weekFromNow.setDate(today.getDate() + 7);
  let completed = 0, ongoing = 0, overdue = 0, dueToday = 0, dueThisWeek = 0;
  (rows || []).forEach((p) => {
    const d0 = p.vaccine_d0 ? new Date(p.vaccine_d0) : null;
    const d3 = p.vaccine_d3 ? new Date(p.vaccine_d3) : null;
    const d7 = p.vaccine_d7 ? new Date(p.vaccine_d7) : null;
    if (d0 && d3 && d7) completed++;
    else if (d0) {
      const base = new Date(d0);
      const expD3 = new Date(base); expD3.setDate(base.getDate() + 3);
      const expD7 = new Date(base); expD7.setDate(base.getDate() + 7);
      if (!d3 && expD3 < today) overdue++;
      else if (!d7 && expD7 < today) overdue++;
      else ongoing++;
      const nxt = !d3 ? expD3 : expD7;
      if (nxt.toDateString() === today.toDateString()) dueToday++;
      else if (nxt >= today && nxt <= weekFromNow) dueThisWeek++;
    } else ongoing++;
  });
  return { completed, ongoing, overdue, dueToday, dueThisWeek };
}

module.exports = { classifyVaccinationSchedules };
