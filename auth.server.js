// auth.server.js - Capa de autenticación EnergyCloud-Encodex
require('dotenv').config();
const express = require('express');
const path = require('path');
const sqlite3 = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const router = express.Router();

// ─── Base de datos de usuarios ───────────────────────────────────────────────
const db = new sqlite3(path.join(__dirname, 'usuariosdb.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS verify_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_sent_at TEXT DEFAULT (datetime('now')),
    resend_count INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL
  );
`);

// ─── Mailer ───────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: process.env.MAIL_SERVICE || 'gmail', // 'gmail' o 'outlook'
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

function generateCode() {
  return crypto.randomInt(1000000, 9999999).toString(); // 7 dígitos
}

async function sendVerificationEmail(email, code) {
  await transporter.sendMail({
    from: `"EnergyCloud Encodex" <${process.env.MAIL_USER}>`,
    to: email,
    subject: '🔐 Tu código de verificación - EnergyCloud Encodex',
    html: `
      <div style="font-family: monospace; background: #0a0a0f; color: #e0e0e0; padding: 40px; border-radius: 12px; max-width: 480px; margin: auto;">
        <h2 style="color: #00e5ff; letter-spacing: 4px; font-size: 13px; text-transform: uppercase;">EnergyCloud — Encodex</h2>
        <h1 style="font-size: 32px; color: #ffffff; margin: 20px 0;">Verifica tu cuenta</h1>
        <p style="color: #888;">Tu código de verificación de 7 dígitos:</p>
        <div style="background: #111; border: 1px solid #00e5ff33; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
          <span style="font-size: 42px; letter-spacing: 12px; color: #00e5ff; font-weight: bold;">${code}</span>
        </div>
        <p style="color: #555; font-size: 13px;">Este código expira en 10 minutos. No lo compartas con nadie.</p>
      </div>
    `,
  });
}

// ─── JWT ──────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'encodex-secret-change-me';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ─── RUTAS ────────────────────────────────────────────────────────────────────

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password)
      return res.status(400).json({ error: 'Todos los campos son requeridos' });

    const emailRegex = /^[^\s@]+@(gmail\.com|hotmail\.com|outlook\.com|live\.com)$/i;
    if (!emailRegex.test(email))
      return res.status(400).json({ error: 'Solo se admiten correos Gmail o Microsoft (Hotmail/Outlook/Live)' });

    if (password.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const exists = db.prepare('SELECT id FROM usuarios WHERE username=? OR email=?').get(username, email);
    if (exists) return res.status(409).json({ error: 'El usuario o correo ya está registrado' });

    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO usuarios (username, email, password_hash) VALUES (?,?,?)').run(username, email, hash);

    // Generar y enviar código
    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM verify_codes WHERE email=?').run(email);
    db.prepare('INSERT INTO verify_codes (email, code, expires_at) VALUES (?,?,?)').run(email, code, expires);

    await sendVerificationEmail(email, code);

    res.json({ ok: true, message: 'Código de verificación enviado a tu correo' });
  } catch (e) {
    console.error('[auth/register]', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /auth/verify
router.post('/verify', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Datos incompletos' });

  const row = db.prepare('SELECT * FROM verify_codes WHERE email=?').get(email);
  if (!row) return res.status(400).json({ error: 'No hay código pendiente para este correo' });

  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM verify_codes WHERE email=?').run(email);
    return res.status(400).json({ error: 'El código ha expirado, solicita uno nuevo' });
  }

  if (row.code !== code.toString()) {
    db.prepare('UPDATE verify_codes SET attempts=attempts+1 WHERE email=?').run(email);
    return res.status(400).json({ error: 'Código incorrecto' });
  }

  // Verificar usuario
  db.prepare('UPDATE usuarios SET verified=1 WHERE email=?').run(email);
  db.prepare('DELETE FROM verify_codes WHERE email=?').run(email);

  const user = db.prepare('SELECT id, username, email FROM usuarios WHERE email=?').get(email);
  const token = signToken({ id: user.id, username: user.username, email: user.email });

  // ── Setear cookie httpOnly para que requireAuth la lea automáticamente ──
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  });

  res.json({ ok: true, token, user: { id: user.id, username: user.username, email: user.email } });
});

// POST /auth/resend
router.post('/resend', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const row = db.prepare('SELECT * FROM verify_codes WHERE email=?').get(email);
    if (!row) return res.status(400).json({ error: 'No hay registro pendiente para este correo' });

    // Lapsus de 1 minuto desde el 2do reenvío
    if (row.resend_count >= 1) {
      const lastSent = new Date(row.last_sent_at);
      const diff = Date.now() - lastSent.getTime();
      if (diff < 60 * 1000) {
        const wait = Math.ceil((60 * 1000 - diff) / 1000);
        return res.status(429).json({ error: `Espera ${wait} segundos antes de reenviar`, wait });
      }
    }

    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare(`
      UPDATE verify_codes SET code=?, expires_at=?, attempts=0,
      last_sent_at=datetime('now'), resend_count=resend_count+1
      WHERE email=?
    `).run(code, expires, email);

    await sendVerificationEmail(email, code);

    res.json({ ok: true, message: 'Nuevo código enviado' });
  } catch (e) {
    console.error('[auth/resend]', e);
    res.status(500).json({ error: 'Error al reenviar código' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier = username o email
    if (!identifier || !password)
      return res.status(400).json({ error: 'Usuario/correo y contraseña son requeridos' });

    const user = db.prepare('SELECT * FROM usuarios WHERE username=? OR email=?').get(identifier, identifier);
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

    if (!user.verified)
      return res.status(403).json({ error: 'Cuenta no verificada. Revisa tu correo.', email: user.email, needsVerification: true });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = signToken({ id: user.id, username: user.username, email: user.email });

    // ── Setear cookie httpOnly para que requireAuth la lea automáticamente ──
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
    });

    res.json({ ok: true, token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (e) {
    console.error('[auth/login]', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /auth/me — protegida
router.get('/me', verifyToken, (req, res) => {
  res.json({ user: req.user });
});


router.post('/forgot', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Usuario o correo requerido' });

    const user = db.prepare('SELECT * FROM usuarios WHERE username=? OR email=?').get(identifier, identifier);
    if (!user) return res.status(404).json({ error: 'No existe ninguna cuenta con ese usuario o correo' });

    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM verify_codes WHERE email=?').run(user.email);
    db.prepare('INSERT INTO verify_codes (email, code, expires_at) VALUES (?,?,?)').run(user.email, code, expires);

    await sendVerificationEmail(user.email, code); // reutiliza el mismo mailer

    res.json({ ok: true, email: user.email });
  } catch (e) {
    console.error('[auth/forgot]', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});



router.post('/forgot-verify', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Datos incompletos' });

  const row = db.prepare('SELECT * FROM verify_codes WHERE email=?').get(email);
  if (!row) return res.status(400).json({ error: 'No hay código pendiente para este correo' });

  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM verify_codes WHERE email=?').run(email);
    return res.status(400).json({ error: 'El código ha expirado, solicita uno nuevo' });
  }

  if (row.code !== code.toString()) {
    db.prepare('UPDATE verify_codes SET attempts=attempts+1 WHERE email=?').run(email);
    return res.status(400).json({ error: 'Código incorrecto' });
  }

  res.json({ ok: true });
});


// Puedes mapear forgot-resend al mismo handler de resend:
router.post('/forgot-resend', router.stack.find(r => r.route?.path === '/resend')?.route.stack[0].handle);
// O simplemente duplica la lógica de /resend — es idéntica.

router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword, newUsername } = req.body;
    if (!email || !code || !newPassword)
      return res.status(400).json({ error: 'Datos incompletos' });

    if (newPassword.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    // Revalidar el código por seguridad
    const row = db.prepare('SELECT * FROM verify_codes WHERE email=?').get(email);
    if (!row || row.code !== code.toString() || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Código inválido o expirado. Inicia el proceso de nuevo.' });

    const hash = await bcrypt.hash(newPassword, 12);

    if (newUsername && newUsername.trim()) {
      // Verificar que el nuevo username no esté tomado
      const taken = db.prepare('SELECT id FROM usuarios WHERE username=? AND email!=?').get(newUsername.trim(), email);
      if (taken) return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });
      db.prepare('UPDATE usuarios SET password_hash=?, username=? WHERE email=?').run(hash, newUsername.trim(), email);
    } else {
      db.prepare('UPDATE usuarios SET password_hash=? WHERE email=?').run(hash, email);
    }

    db.prepare('DELETE FROM verify_codes WHERE email=?').run(email);

    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/reset-password]', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});



module.exports = { router, verifyToken };