'use strict';

const http = require('http');

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: text.slice(0, 300) });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  const raw = login.headers['set-cookie'] || [];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  if (!login.json || !login.json.success) {
    console.log('LOGIN_FAIL', login.status, login.text);
    process.exit(1);
  }
  const inv = await req('GET', '/api/inventory', { cookie });
  if (!inv.json || !inv.json.success) {
    console.log('INV_FAIL', inv.status, inv.text);
    process.exit(1);
  }
  const rows = (inv.json.data || []).map((lot) => ({
    vaccine: lot.vaccine_name,
    batch: lot.batch_number || ('#' + lot.inventory_id),
    additional: lot.additional_stock,
    remaining: lot.usable_quantity,
    expiry: String(lot.expiry_date || '').slice(0, 10),
    record_status: lot.record_status,
    batch_status: lot.batch_status,
  }));
  const bad = rows.filter((r) => !['Received', 'Corrected', 'Expired'].includes(r.record_status));
  const stockWords = rows.filter((r) => ['Available', 'Low Stock', 'Critical', 'Depleted', 'Out of Stock'].includes(r.record_status));
  console.log(JSON.stringify({
    count: rows.length,
    badStatuses: bad.length,
    stockLevelStatuses: stockWords.length,
    rows,
  }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
