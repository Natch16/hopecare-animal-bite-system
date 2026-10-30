const express         = require('express');
const session         = require('express-session');
const cors            = require('cors');
const path            = require('path');
const fs              = require('fs');
// Try loading .env from current directory first (Hostinger), then from __dirname
const envPath = fs.existsSync(path.join(process.cwd(), '.env')) 
  ? path.join(process.cwd(), '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

const { initPool }    = require('./config/database');
const { requirePageAccess } = require('./middleware/auth');
const { startReminderScheduler } = require('./services/reminderScheduler');
const aiClient = require('./utils/groqClient');

const PROTECTED_PAGES = [
  // ── Nurse ────────────────────────────────────────────────────────
  { route: '/nurse/dashboard.html',           file: 'nurse/dashboard.html' },
  { route: '/nurse/patients.html',            file: 'nurse/patients.html' },
  { route: '/nurse/patient-episodes.html',    file: 'nurse/patient-episodes.html' },
  { route: '/nurse/followup.html',            file: 'nurse/followup.html' },
  { route: '/nurse/vaccination.html',         file: 'nurse/vaccination.html' },
  { route: '/nurse/map.html',                 file: 'nurse/map.html' },
  { route: '/nurse/analytics.html',           file: 'nurse/analytics.html' },
  { route: '/nurse/reports.html',             file: 'nurse/reports.html' },
  // ── Admin ────────────────────────────────────────────────────────
  { route: '/admin/admin-dashboard.html',     file: 'admin/admin-dashboard.html' },
  { route: '/admin/staff-management.html',    file: 'admin/staff-management.html' },
  { route: '/admin/patient-accounts.html',    file: 'admin/patient-accounts.html' },
  { route: '/admin/inventory.html',           file: 'admin/inventory.html' },
  { route: '/admin/inventory-history.html',   file: 'admin/inventory-history.html' },
  { route: '/admin/inventory-analytics.html', file: 'admin/inventory-analytics.html' },
  { route: '/admin/inventory-reports.html',   file: 'admin/inventory-reports.html' },
  { route: '/admin/ai-predictive.html',       file: 'admin/ai-predictive.html' },
  // ── Shared (Nurse + Admin) ────────────────────────────────────────
  { route: '/shared/activity-logs.html',      file: 'shared/activity-logs.html' },
  { route: '/shared/settings.html',           file: 'shared/settings.html' },
];

async function startServer() {
  await initPool();

  const app  = express();
  const PORT = process.env.PORT || 3000;
  // Support both local dev (backend/../frontend) and Hostinger deploy (./frontend)
  const fs = require('fs');
  let frontendDir = path.join(__dirname, 'frontend');
  if (!fs.existsSync(frontendDir)) {
    // Fallback to local dev structure
    frontendDir = path.join(__dirname, '..', 'frontend');
  }

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret:            process.env.SESSION_SECRET || 'hopecare-secret-2024',
    resave:            false,
    saveUninitialized: false,
    cookie:            { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 24 * 60 * 60 * 1000 },
  }));

  app.use('/api/auth',            require('./routes/auth'));
  app.use('/api/staff',           require('./routes/staff'));
  app.use('/api/activity-logs', require('./routes/activityLogs'));
  app.use('/api/patients',        require('./routes/patients'));
  app.use('/api/episodes',        require('./routes/episodes'));
  app.use('/api/cases',           require('./routes/cases'));
  app.use('/api/analytics',       require('./routes/analytics'));
  app.use('/api/followup',        require('./routes/followup'));
  app.use('/api/settings',        require('./routes/settings'));
  app.use('/api/inventory',       require('./routes/inventory'));
  app.use('/api/patient-accounts', require('./routes/patientAccounts'));
  app.use('/api/admin',           require('./routes/admin'));
  app.use('/api/inventory-analytics', require('./routes/inventoryAnalytics'));
  app.use('/api/inventory-reports', require('./routes/inventoryReports'));
  app.use('/api/inventory-ai',    require('./routes/inventoryAI'));
  app.use('/api/patient/auth',    require('./routes/patientAuth'));
  app.use('/api/patient',         require('./routes/patientPortal'));
  app.use('/api/sms',             require('./routes/sms'));

  // ── Root and shared ──────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.sendFile(path.join(frontendDir, 'shared/login.html'));
  });
  app.get('/shared/login.html', (req, res) => {
    res.sendFile(path.join(frontendDir, 'shared/login.html'));
  });
  // Legacy flat-path redirects → new locations (301 permanent)
  app.get('/login.html',              (req, res) => res.redirect(301, '/shared/login.html'));
  app.get('/activity-logs.html',      (req, res) => res.redirect(301, '/shared/activity-logs.html'));
  app.get('/settings.html',           (req, res) => res.redirect(301, '/shared/settings.html'));

  // ── Patient portal ────────────────────────────────────────────────
  app.get('/patient-login',                   (req, res) => res.sendFile(path.join(frontendDir, 'patient/patient-login.html')));
  app.get('/patient/patient-login.html',      (req, res) => res.sendFile(path.join(frontendDir, 'patient/patient-login.html')));
  app.get('/patient-login.html',              (req, res) => res.redirect(301, '/patient/patient-login.html'));

  app.get('/patient-dashboard',               (req, res) => res.sendFile(path.join(frontendDir, 'patient/patient-dashboard.html')));
  app.get('/patient/patient-dashboard.html',  (req, res) => res.sendFile(path.join(frontendDir, 'patient/patient-dashboard.html')));
  app.get('/patient-dashboard.html',          (req, res) => res.redirect(301, '/patient/patient-dashboard.html'));

  app.get('/patient/patient-card.html',       (req, res) => res.sendFile(path.join(frontendDir, 'patient/patient-card.html')));
  app.get('/patient-card.html',               (req, res) => res.redirect(301, '/patient/patient-card.html'));

  // ── Legacy nurse flat-path redirects ─────────────────────────────
  app.get('/dashboard.html',              (req, res) => res.redirect(301, '/nurse/dashboard.html'));
  app.get('/patients.html',               (req, res) => res.redirect(301, '/nurse/patients.html'));
  app.get('/patient-episodes.html',       (req, res) => res.redirect(301, '/nurse/patient-episodes.html'));
  app.get('/followup.html',               (req, res) => res.redirect(301, '/nurse/followup.html'));
  app.get('/vaccination.html',            (req, res) => res.redirect(301, '/nurse/vaccination.html'));
  app.get('/map.html',                    (req, res) => res.redirect(301, '/nurse/map.html'));
  app.get('/analytics.html',              (req, res) => res.redirect(301, '/nurse/analytics.html'));
  app.get('/reports.html',                (req, res) => res.redirect(301, '/nurse/reports.html'));

  // ── Legacy admin flat-path redirects ─────────────────────────────
  app.get('/admin-dashboard.html',        (req, res) => res.redirect(301, '/admin/admin-dashboard.html'));
  app.get('/staff-management.html',       (req, res) => res.redirect(301, '/admin/staff-management.html'));
  app.get('/patient-accounts.html',       (req, res) => res.redirect(301, '/admin/patient-accounts.html'));
  app.get('/inventory.html',              (req, res) => res.redirect(301, '/admin/inventory.html'));
  app.get('/inventory-history.html',      (req, res) => res.redirect(301, '/admin/inventory-history.html'));
  app.get('/inventory-analytics.html',    (req, res) => res.redirect(301, '/admin/inventory-analytics.html'));
  app.get('/inventory-reports.html',      (req, res) => res.redirect(301, '/admin/inventory-reports.html'));
  app.get('/ai-predictive.html',          (req, res) => res.redirect(301, '/admin/ai-predictive.html'));

  PROTECTED_PAGES.forEach(({ route, file }) => {
    app.get(route, requirePageAccess(file), (req, res) => {
      res.sendFile(path.join(frontendDir, file));
    });
  });

  app.use(express.static(frontendDir));

  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  });

  startReminderScheduler();

  app.listen(PORT, () => {
    console.log(`🚀  Server running at http://localhost:${PORT}`);
    const gs = aiClient.status();
    console.log(`[groq] model=${gs.model} keyConfigured=${gs.configured ? 'yes' : 'no'}`);
    if (!gs.configured) {
      console.error('[groq]', gs.errorCode, gs.message, 'Set GROQ_API_KEY in backend/.env and restart the server.');
    }
  });
}

startServer().catch(err => {
  console.error('❌  Failed to start server:', err.message);
  process.exit(1);
});
