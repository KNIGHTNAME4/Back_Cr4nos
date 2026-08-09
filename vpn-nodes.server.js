// vpn-nodes.server.js
// creado para el modulo de VPN — maneja el registro de nodos (raspis/windows)
// y la asignacion de IP virtual + nombre, guardado en una DB local en disco.
//
// Almacenamiento DOBLE:
//   1) JSON en disco (data/vpn_nodes.json) — sigue siendo la fuente que se
//      lee en cada request, igual que antes.
//   2) SQLite en disco (data/vpn_nodes.sqlite) — se escribe en espejo cada
//      vez que se guarda el JSON, como respaldo. Si el JSON se borra o se
//      corrompe, al arrancar el server se reconstruye automaticamente desde
//      el sqlite.
//
// Para el sqlite se usa "sql.js" (motor SQLite compilado a WebAssembly) en
// vez de better-sqlite3 / sqlite3, porque esos requieren compilacion nativa
// y ya habiamos tenido problemas con eso en Azure App Service. sql.js es
// javascript + wasm puro, no necesita node-gyp ni nada por el estilo.
//
// Instalar antes de correr:  npm install sql.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'vpn_nodes.json');
const SQLITE_PATH = path.join(DATA_DIR, 'vpn_nodes.sqlite');
const BRIDGE_SECRET = process.env.VPN_BRIDGE_SECRET || 'feab4ef10d7c85133153f56128a83cd3714c1081e0cfe87b9c0c9cf2c453403d';

// red virtual de la VPN — mismo rango que ya usa el controller (10.66.0.0/24)
const SUBNET_PREFIX = '10.66.0.';
const FIRST_HOST = 2;   // .1 se reserva para la VM/controller si hiciera falta
const LAST_HOST = 254;

let writeQueue = Promise.resolve(); // evita pisadas si llegan registros en paralelo

// ────────────────────────────────────────────────────────────────────────
// SQLITE (sql.js) — respaldo en espejo del JSON
// ────────────────────────────────────────────────────────────────────────
let SQL = null;
let sqliteDb = null;

async function initSqlite() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  SQL = await initSqlJs();

  sqliteDb = fs.existsSync(SQLITE_PATH)
    ? new SQL.Database(fs.readFileSync(SQLITE_PATH))
    : new SQL.Database();

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS clientes (
      cliente     TEXT PRIMARY KEY,   -- siempre en MAYUSCULA
      network_id  TEXT UNIQUE NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS nodos (
      machine_id  TEXT PRIMARY KEY,   -- id que reporta el equipo (raspi/windows)
      node_id     TEXT UNIQUE NOT NULL, -- id nodal: unico por equipo
      name        TEXT,
      cliente     TEXT,
      network_id  TEXT,               -- id de red: unico por cliente
      ip          TEXT,
      uuid        TEXT,
      mac         TEXT,
      enabled     INTEGER,
      created_at  TEXT,
      last_seen   TEXT
    );
  `);

  persistSqlite();
}

function persistSqlite() {
  if (!sqliteDb) return;
  fs.writeFileSync(SQLITE_PATH, Buffer.from(sqliteDb.export()));
}

function upsertClienteSqlite(clienteUpper, networkId) {
  if (!sqliteDb || !clienteUpper) return;
  sqliteDb.run(
    `INSERT INTO clientes (cliente, network_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(cliente) DO UPDATE SET network_id = excluded.network_id`,
    [clienteUpper, networkId, new Date().toISOString()]
  );
}

function upsertNodeSqlite(node) {
  if (!sqliteDb) return;
  sqliteDb.run(
    `INSERT INTO nodos (machine_id, node_id, name, cliente, network_id, ip, uuid, mac, enabled, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET
       node_id = excluded.node_id, name = excluded.name, cliente = excluded.cliente,
       network_id = excluded.network_id, ip = excluded.ip, uuid = excluded.uuid,
       mac = excluded.mac, enabled = excluded.enabled, last_seen = excluded.last_seen`,
    [
      node.id, node.nodeId, node.name || '', node.cliente || '', node.networkId || '',
      node.ip || '', node.uuid || '', node.mac || '', node.enabled ? 1 : 0,
      node.createdAt || new Date().toISOString(), node.lastSeen || null,
    ]
  );
}

function deleteNodeSqlite(machineId) {
  if (!sqliteDb) return;
  sqliteDb.run('DELETE FROM nodos WHERE machine_id = ?', [machineId]);
}

function countNodesSqlite() {
  if (!sqliteDb) return 0;
  const res = sqliteDb.exec('SELECT COUNT(*) AS c FROM nodos');
  return res.length ? res[0].values[0][0] : 0;
}

// reconstruye el JSON desde el sqlite — se usa si el JSON se borro/corrompio
function restoreJsonFromSqlite() {
  const db = { nodes: {}, clientes: {} };

  const clientesRes = sqliteDb.exec('SELECT cliente, network_id FROM clientes');
  if (clientesRes.length) {
    for (const [cliente, networkId] of clientesRes[0].values) {
      db.clientes[cliente] = networkId;
    }
  }

  const nodosRes = sqliteDb.exec(
    'SELECT machine_id, node_id, name, cliente, network_id, ip, uuid, mac, enabled, created_at, last_seen FROM nodos'
  );
  if (nodosRes.length) {
    for (const row of nodosRes[0].values) {
      const [machineId, nodeId, name, cliente, networkId, ip, uuid, mac, enabled, createdAt, lastSeen] = row;
      db.nodes[machineId] = {
        id: machineId,
        nodeId,
        name,
        cliente: cliente || '',
        networkId: networkId || '',
        ip,
        uuid: uuid || '',
        mac: mac || '',
        enabled,
        createdAt,
        lastSeen: lastSeen || null,
      };
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function syncAllToSqlite(db) {
  for (const [cliente, networkId] of Object.entries(db.clientes || {})) {
    upsertClienteSqlite(cliente, networkId);
  }
  for (const node of Object.values(db.nodes)) {
    upsertNodeSqlite(node);
  }
  persistSqlite();
}

// ────────────────────────────────────────────────────────────────────────
// IDs unicos
// ────────────────────────────────────────────────────────────────────────

// "ID nodal" — unico por equipo. ej: ND-3F9A2C
function genNodeId() {
  return 'ND-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// "ID de red" — unico por cliente. ej: RED-8B21F0
function genNetworkId() {
  return 'RED-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function uniqueNodeId(db) {
  const used = new Set(Object.values(db.nodes).map((n) => n.nodeId).filter(Boolean));
  let id;
  do { id = genNodeId(); } while (used.has(id));
  return id;
}

// dado un texto de cliente, devuelve { clienteUpper, networkId }.
// Si el cliente ya existia (comparando en MAYUSCULA) reutiliza el mismo
// id de red. Si es un cliente nuevo, genera uno nuevo y lo guarda.
function resolveNetworkId(db, clienteRaw) {
  const clienteUpper = (clienteRaw || '').trim().toUpperCase();
  if (!clienteUpper) return { clienteUpper: '', networkId: '' };

  if (!db.clientes) db.clientes = {};

  let networkId = db.clientes[clienteUpper];
  if (!networkId) {
    const used = new Set(Object.values(db.clientes));
    do { networkId = genNetworkId(); } while (used.has(networkId));
    db.clientes[clienteUpper] = networkId;
    upsertClienteSqlite(clienteUpper, networkId);
  }
  return { clienteUpper, networkId };
}

// ────────────────────────────────────────────────────────────────────────
// JSON (fuente principal de lectura)
// ────────────────────────────────────────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({ nodes: {}, clientes: {} }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!db.clientes) db.clientes = {};

  // ── migracion de datos viejos ──
  // - nodos sin "cliente": se les agrega vacio
  // - clientes guardados en minuscula: se pasan a mayuscula
  // - nodos sin "nodeId": se les asigna uno unico (id nodal)
  // - nodos con cliente pero sin "networkId": se les enlaza el id de red
  let migrated = false;

  for (const node of Object.values(db.nodes)) {
    if (node.cliente === undefined) {
      node.cliente = '';
      migrated = true;
    } else if (node.cliente) {
      const upper = node.cliente.trim().toUpperCase();
      if (node.cliente !== upper) {
        node.cliente = upper;
        migrated = true;
      }
    }

    if (!node.nodeId) {
      node.nodeId = uniqueNodeId(db);
      migrated = true;
    }

    if (node.cliente && !node.networkId) {
      const { networkId } = resolveNetworkId(db, node.cliente);
      node.networkId = networkId;
      migrated = true;
    } else if (!node.networkId) {
      node.networkId = '';
    }
  }

  if (migrated) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }

  return db;
}

function saveDB(db) {
  writeQueue = writeQueue.then(() =>
    fs.promises.writeFile(DB_PATH, JSON.stringify(db, null, 2))
  );
  return writeQueue;
}

async function initVpnNodesDB() {
  await initSqlite();

  const jsonExists = fs.existsSync(DB_PATH);
  const jsonNodeCount = jsonExists
    ? Object.keys(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')).nodes || {}).length
    : 0;

  if (jsonNodeCount === 0 && countNodesSqlite() > 0) {
    // el JSON no tiene nada pero el sqlite si — probablemente se borro
    // el JSON por accidente. Lo reconstruimos desde el respaldo.
    console.log('[vpn-nodes] vpn_nodes.json vacio/ausente, restaurando desde sqlite…');
    restoreJsonFromSqlite();
  }

  const db = loadDB(); // corre migraciones (ids nodales, ids de red, etc.)
  syncAllToSqlite(db); // deja el sqlite espejado con el JSON ya migrado

  console.log('[vpn-nodes] DB lista (json + sqlite) en', DATA_DIR);
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
      nodeId: uniqueNodeId(db), // ID nodal — unico por equipo, se asigna una sola vez
      name: defaultName(machineId),
      ip: nextFreeIP(db),
      cliente: '',
      networkId: '', // se completa cuando se le asigna un cliente desde el panel
      enabled: 0, // por defecto BLOQUEADO — hay que autorizarlo a mano desde el panel
      createdAt: new Date().toISOString(),
    };
    db.nodes[machineId] = node;
  }
  node.lastSeen = new Date().toISOString();
  await saveDB(db);
  upsertNodeSqlite(node);
  persistSqlite();

  res.json({ ip: node.ip, name: node.name, enabled: !!node.enabled, nodeId: node.nodeId });
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
  const { name, uuid, mac, cliente, enabled } = req.body || {};

  const db = loadDB();
  const node = db.nodes[machineId];
  if (!node) return res.status(404).json({ error: 'nodo no encontrado' });

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'nombre invalido' });
    node.name = name.trim();
  }
  if (uuid !== undefined) node.uuid = uuid.trim();
  if (mac !== undefined) node.mac = mac.trim();

  if (cliente !== undefined) {
    // el cliente siempre se guarda en MAYUSCULA. Si ya existia un cliente
    // con ese mismo nombre, se reutiliza su id de red; si es nuevo, se
    // genera uno.
    const { clienteUpper, networkId } = resolveNetworkId(db, cliente);
    node.cliente = clienteUpper;
    node.networkId = networkId;
  }

  if (enabled !== undefined) node.enabled = enabled ? 1 : 0;

  await saveDB(db);
  upsertNodeSqlite(node);
  persistSqlite();
  res.json(node);
});

adminRouter.delete('/:machineId', async (req, res) => {
  const { machineId } = req.params;
  const db = loadDB();
  if (!db.nodes[machineId]) return res.status(404).json({ error: 'nodo no encontrado' });
  delete db.nodes[machineId];
  await saveDB(db);
  deleteNodeSqlite(machineId);
  persistSqlite();
  res.json({ ok: true });
});

module.exports = { bridgeRouter, adminRouter, initVpnNodesDB };