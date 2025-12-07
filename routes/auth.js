const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../config/supabase');
require('dotenv').config({ override: true });

// Google OAuth Callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // ตรวจสอบว่ามี error จาก Google หรือไม่
    if (error) {
      return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent(error)}`);
    }

    // ตรวจสอบว่ามี authorization code หรือไม่
    if (!code) {
      return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent('Authorization code not found')}`);
    }

    // ตรวจสอบ environment variables
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
      console.error('Missing Google OAuth environment variables');
      console.error('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Missing');
      console.error('GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? 'Set' : 'Missing');
      console.error('GOOGLE_REDIRECT_URI:', process.env.GOOGLE_REDIRECT_URI || 'Missing');
      return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent('Server configuration error')}`);
    }

    // Exchange authorization code สำหรับ access token และ refresh token
    let tokenResponse;
    try {
      tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      });
    } catch (tokenError) {
      const errorData = tokenError.response?.data || {};
      console.error('Token exchange error:', errorData.error);
      
      // Handle specific Google OAuth errors (generic messages for security)
      if (errorData.error === 'invalid_client') {
        return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent('Authentication configuration error')}`);
      }
      
      if (errorData.error === 'invalid_grant') {
        return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent('Authorization code expired or invalid')}`);
      }
      
      if (errorData.error === 'redirect_uri_mismatch') {
        return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent('Authentication configuration error')}`);
      }
      
      return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent('Authentication failed')}`);
    }

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    if (!access_token) {
      return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent('Failed to get access token')}`);
    }

    // ดึงข้อมูล user จาก Google
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    });

    const googleUser = userResponse.data;
    const { email, name, picture } = googleUser;
    const domain = email.split('@')[1];

    // ตรวจสอบ email domain (ถ้าต้องการจำกัดเฉพาะบริษัท)
    // อนุญาตทั้งหมดถ้าไม่มีการตั้งค่า ALLOWED_EMAIL_DOMAINS หรือเป็นค่าว่าง
    const allowedDomainsEnv = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
    if (allowedDomainsEnv) {
      const allowedDomains = allowedDomainsEnv.split(',').map(d => d.trim()).filter(d => d);
      
      if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
        const errorMsg = `Access denied: Email domain "${domain}" is not allowed.`;
        return res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent(errorMsg)}`);
      }
    }

    // คำนวณ token expiration time
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);

    // ตรวจสอบว่ามี user อยู่แล้วหรือไม่
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    let user;

    if (existingUser) {
      // อัปเดต user ที่มีอยู่
      const { data, error: updateError } = await supabase
        .from('users')
        .update({
          display_name: name,
          domain: domain,
          google_refresh_token: refresh_token,
          google_token_expires_at: tokenExpiresAt.toISOString()
        })
        .eq('email', email)
        .select()
        .single();

      if (updateError) {
        throw updateError;
      }

      user = data;
    } else {
      // สร้าง user ใหม่
      const { data, error: insertError } = await supabase
        .from('users')
        .insert({
          email: email,
          display_name: name,
          domain: domain,
          google_refresh_token: refresh_token,
          google_token_expires_at: tokenExpiresAt.toISOString()
        })
        .select()
        .single();

      if (insertError) {
        throw insertError;
      }

      user = data;
    }

    // เก็บ access token ใน HTTP-only cookie
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction, // บังคับ HTTPS ใน production
      sameSite: isProduction ? 'none' : 'lax', // 'none' สำหรับ cross-domain ใน production
      maxAge: expires_in * 1000 // ใช้เวลาเดียวกับ token expiration
    };

    res.cookie('access_token', access_token, cookieOptions);

    // Redirect ไปยัง frontend
    res.redirect(`${frontendUrl}/dashboard?success=true`);

  } catch (err) {
    console.error('Callback error:', err);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const errorMessage = process.env.NODE_ENV === 'development' ? err.message : 'Internal server error';
    res.redirect(`${frontendUrl}/dashboard?error=${encodeURIComponent(errorMessage)}`);
  }
});

// Get current user
router.get('/me', async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify token และดึงข้อมูล user จาก Google API
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const googleUser = userResponse.data;
    const { email } = googleUser;

    // ดึงข้อมูล user จาก database
    const { data: user, error: dbError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (dbError || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // ส่งข้อมูล user พร้อม picture จาก Google
    res.json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        domain: user.domain,
        picture: googleUser.picture
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    
    // ถ้า token หมดอายุหรือ invalid
    if (err.response?.status === 401) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', async (req, res) => {
  try {
    const isProduction = process.env.NODE_ENV === 'production';
    // Clear access token cookie
    res.clearCookie('access_token', {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
    });

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

