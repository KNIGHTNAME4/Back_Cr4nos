const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'encodex-secret-change-me';

// TODO: mover a .env o a tabla de usuarios con hash (bcrypt) — por ahora
// ya no vive en el bundle del cliente, que era el problema real
const ADMIN_USER = process.env.ADMIN_USER || 'Daniel';
const ADMIN_PASS = process.env.ADMIN_PASS || 'VitateZev123$'; 

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  const token = jwt.sign(
    { username, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
  });

  res.json({ ok: true, user: { username, role: 'admin' } });
});

router.get('/me', requireAdminAuth, (req, res) => {
  res.json({ user: { username: req.admin.username, role: req.admin.role } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

function requireAdminAuth(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = { router, requireAdminAuth };