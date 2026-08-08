// vpn-nodes.server.js
// creado para el modulo de VPN — maneja el registro de nodos (raspis/windows)
// y la asignacion de IP virtual + nombre, guardado en una DB local en disco.
//
// No usa un motor de DB con dependencias nativas (better-sqlite3, etc.) para
// evitar problemas de compilacion en Azure App Service — es un JSON simple
// con lectura/escritura serializada. Si ya tenes sqlite corriendo en
// Serverxt2.js y preferis usar esa misma DB, la unica funcion que hay que
// tocar es loadDB()/saveDB() de aca abajo, el resto (rutas, logica de IP)
// queda igual.

const fs = require('fs');
const path = require('path');
const express = require('express');

const DB_PATH = path.join(__dirname, 'data', 'vpn_nodes.json');
const BRIDGE_SECRET = process.env.VPN_BRIDGE_SECRET || 'feab4ef10d7c85133153f56128a83cd3714c1081e0cfe87b9c0c9cf2c453403d';

// red virtual de la VPN — mismo rango que ya usa el controller (10.66.0.0/24)
const SUBNET_PREFIX = '10.66.0.';
const FIRST_HOST = 2;   // .1 se reserva para la VM/controller si hiciera falta
const LAST_HOST = 254;

let writeQueue = Promise.resolve(); // evita pisadas si llegan registros en paralelo

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({ nodes: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(db) {
  writeQueue = writeQueue.then(() =>
    fs.promises.writeFile(DB_PATH, JSON.stringify(db, null, 2))
  );
  return writeQueue;
}

async function initVpnNodesDB() {
  loadDB(); // solo para asegurar que el archivo exista al arrancar
  console.log('[vpn-nodes] DB lista en', DB_PATH);
}

function nextFreeIP(db) {
  const used = new Set(Object.values(db.nodes).map(n => n.ip));
  for (let i = FIRST_HOST; i <= LAST_HOST; i++) {
    const candidate = SUBNET_PREFIX + i;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('sin IPs libres en el rango 10.66.0.0/24');
}

// nombre por defecto legible, ej: "nodo-3a2f9c"
function defaultName(machineId) {
  return 'nodo-' + machineId.slice(-6).toLowerCase();
}

// ─── Router "bridge": lo llama vpn-registry-bridge.js desde la VM ──────────
// NO usa el JWT de usuarios (requireAuth) — usa un secreto compartido propio,
// porque quien llama es una maquina (la VM), no una persona logueada.
const bridgeRouter = express.Router();

bridgeRouter.post('/register', async (req, res) => {
  const key = req.headers['x-bridge-key'];
  if (key !== BRIDGE_SECRET) {
    return res.status(401).json({ error: 'bridge key invalida' });
  }

  const { machineId } = req.body || {};
  if (!machineId || typeof machineId !== 'string') {
    return res.status(400).json({ error: 'machineId requerido' });
  }

  const db = loadDB();
  let node = db.nodes[machineId];

  if (!node) {
    node = {
      id: machineId,
      name: defaultName(machineId),
      ip: nextFreeIP(db),
      createdAt: new Date().toISOString(),
    };
    db.nodes[machineId] = node;
  }
  node.lastSeen = new Date().toISOString();
  await saveDB(db);

  res.json({ ip: node.ip, name: node.name });
});

// ─── Router "admin": lo usa el panel React, protegido por requireAuth ──────
// (requireAuth ya se aplica solo, porque index.js monta esto bajo /api/...)
const adminRouter = express.Router();

adminRouter.get('/', (req, res) => {
  const db = loadDB();
  res.json(Object.values(db.nodes));
});

adminRouter.put('/:machineId', async (req, res) => {
  const { machineId } = req.params;
  const { name, uuid, mac } = req.body || {};

  const db = loadDB();
  const node = db.nodes[machineId];
  if (!node) return res.status(404).json({ error: 'nodo no encontrado' });

  // cada campo se actualiza solo si vino en el body — asi el modal de
  // "editar" puede mandar solo uuid+mac sin pisar el nombre, o al reves.
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'nombre invalido' });
    node.name = name.trim();
  }
  if (uuid !== undefined) node.uuid = uuid.trim();
  if (mac !== undefined) node.mac = mac.trim();

  await saveDB(db);
  res.json(node);
});

adminRouter.delete('/:machineId', async (req, res) => {
  const { machineId } = req.params;
  const db = loadDB();
  if (!db.nodes[machineId]) return res.status(404).json({ error: 'nodo no encontrado' });
  delete db.nodes[machineId];
  await saveDB(db);
  res.json({ ok: true });
});

module.exports = { bridgeRouter, adminRouter, initVpnNodesDB };