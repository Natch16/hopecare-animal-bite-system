const {
  normalizeRole,
  getPermissionsForRole,
  hasPermission,
  canAccessPage,
  getDefaultHomePage,
} = require('../utils/permissions');

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn && req.session.staffId) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Not authenticated. Please sign in.' });
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session?.loggedIn || !req.session?.staffId) {
      return res.status(401).json({ success: false, message: 'Not authenticated. Please sign in.' });
    }
    const role = normalizeRole(req.session.role);
    if (!hasPermission(role, permission)) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
    }
    return next();
  };
}

function requireRole(...roles) {
  const allowed = roles.map(r => normalizeRole(r));
  return (req, res, next) => {
    if (!req.session?.loggedIn || !req.session?.staffId) {
      return res.status(401).json({ success: false, message: 'Not authenticated. Please sign in.' });
    }
    const role = normalizeRole(req.session.role);
    if (!allowed.includes(role)) {
      return res.status(403).json({ success: false, message: 'Access denied. Administrator role required.' });
    }
    return next();
  };
}

function requirePageAccess(pageName) {
  return (req, res, next) => {
    if (!req.session?.loggedIn || !req.session?.staffId) {
      return res.redirect('/shared/login.html');
    }
    const role = normalizeRole(req.session.role);
    if (!canAccessPage(role, pageName)) {
      return res.redirect(getDefaultHomePage(role) + '?denied=1');
    }
    return next();
  };
}

function getStaffFromSession(req) {
  return {
    staff_id: req.session?.staffId || null,
    username: req.session?.username || null,
    full_name: req.session?.fullName || null,
    designation: req.session?.designation || null,
    role: normalizeRole(req.session?.role),
  };
}

function getAuditBy(req) {
  return req.session?.fullName || req.session?.username || null;
}

module.exports = {
  requireAuth,
  requirePermission,
  requireRole,
  requirePageAccess,
  getStaffFromSession,
  getAuditBy,
  getPermissionsForRole,
  normalizeRole,
  hasPermission,
  getDefaultHomePage,
};
