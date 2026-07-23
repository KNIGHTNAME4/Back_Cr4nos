require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');  // creado el 16/05/2026 V0.4
const { initDB, getAllNodes } = require('./Serverxt2');
const { router: authRouter } = require('./auth.server'); // creado el 16/05/2026 V0.0.4
const cookieParser = require('cookie-parser'); // creado el 16/05/2026 V0.0.4


const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'encodex-secret-change-me'; // creado el 16/05/2026 V0.0.4

// Serve React build
//app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.json());
app.use(cookieParser()); // ← FALTABA ESTO — sin esto req.cookies siempre es undefined
app.use('/api', requireAuth);




 
// ─── Auth routes ──────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
 
// ─── Servir distlogin (React auth app) ───────────────────────────────────────
app.use('/login', express.static(path.join(__dirname, 'distlogin')));
app.get(/^\/login\/.*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'distlogin', 'index.html'));
});

app.get('/forgot', (req, res) => {
  res.sendFile(path.join(__dirname, 'distlogin', 'index.html'));
});
app.get(/^\/forgot\/.*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'distlogin', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
 
// ─── Middleware de autenticación para la plataforma ───────────────────────────
function requireAuth(req, res, next) {
  // Permitir assets estáticos sin token
  const ext = path.extname(req.path);
  if (ext && ext !== '.html') return next();
 
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
 
  // Sin token → redirigir al login
  if (!token) return res.redirect('/login');
 
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.redirect('/login');
  }
}


app.get('/', (req, res) => res.redirect('/login'));// creado el 16/05/2026 V0.0.4


// REST: get all persisted nodes from SQLite
app.get('/api/nodes', async (req, res) => {
  try {
    const nodes = await getAllNodes();
    res.json(nodes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Splash screen (animación post-login) ────────────────────────────────────
app.get('/splash', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'energycloudv4.html'));
});


// ─── Servir dist (plataforma React) con protección ───────────────────────────
app.use('/app', requireAuth, express.static(path.join(__dirname, 'dist')));
app.get(/^\/app\/.*$/, requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// SPA fallback SIN PRTECCION (para React Router en modo BrowserRouter)
//app.get((req, res) => {
 // res.sendFile(path.join(__dirname, 'dist', 'index.html'));
//});

// GET /api/me — devuelve el usuario autenticado desde la cookie
app.get('/api/me', requireAuth, (req, res) => {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: { id: decoded.id, username: decoded.username, email: decoded.email } });
  } catch {
    res.status(401).json({ error: 'No autenticado' });
  }
});



// WebSocket: broadcast live node state to all connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}



// Start MQTT engine, pass broadcast function
const { startMQTT } = require('./Serverxt2');

async function main() {
  await initDB();
  startMQTT(broadcast);

  server.listen(PORT, () => {
    console.log(`[Cr4nos] Server running on http://localhost:${PORT}`);
    console.log(`[Encodex] Login  → http://localhost:${PORT}/login`);
    console.log(`[Encodex] App    → http://localhost:${PORT}/app`);
  });
}

main().catch(console.error);