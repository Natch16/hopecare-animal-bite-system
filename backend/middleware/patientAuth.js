function requirePatientAuth(req, res, next) {
  if (req.session && req.session.patientLoggedIn && req.session.patientId) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Not authenticated. Please sign in.' });
}

function getPatientFromSession(req) {
  return {
    patient_id: req.session?.patientId || null,
    registration_number: req.session?.registrationNumber || null,
    full_name: req.session?.fullName || null,
  };
}

module.exports = { requirePatientAuth, getPatientFromSession };
