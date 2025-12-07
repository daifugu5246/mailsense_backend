const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

// Get all routes info
router.get('/', (req, res) => {
  res.json({
    message: 'API Routes',
    version: '1.0.0',
    endpoints: [
      'GET /api',
      'GET /api/auth/google/callback',
      'GET /api/auth/me',
      'POST /api/auth/logout',
      'GET /api/mails',
      'POST /api/mails/fetch',
      'PATCH /api/mails/correctness',
      'PATCH /api/mails/interaction',
    ]
  });
});

module.exports = router;
