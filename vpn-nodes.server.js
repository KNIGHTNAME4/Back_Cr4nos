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
// SUBREDES POR CLIENTE:
//   Cada cliente que se crea recibe su propia subred /24 dentro de
//   10.66.x.0/24 (x = 1..254), asi los equipos de un cliente nunca
//   comparten rango de IP virtual con los de otro. Los equipos que
//   todavia no tienen cliente asignado viven en la subred por defecto
//   10.66.0.0/24. Si a un equipo se le asigna (o se le saca) un cliente
//   desde el panel, se le reasigna la IP a la subred que corresponda.
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

// red virtual de la VPN — ahora dividida en subredes /24 por cliente,
// dentro de 10.66.0.0/16.
const SUBNET_BASE = '10.66.';
const DEFAULT_SUBNET_INDEX = 0;     // 10.66.0.0/24 — equipos SIN cliente asignado
const CLIENT_SUBNET_FIRST = 1;      // 10.66.1.0/24 .. 10.66.254.0/24 — un bloque por cliente
const CLIENT_SUBNET_LAST = 254;
const FIRST_HOST = 2;   // .1 se reserva para la VM/controller si hiciera falta
const LAST_HOST = 254;

function subnetPrefixFor(subnetIndex) {
  return `${SUBNET_BASE}${subnetIndex}.`;
}

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
      cliente      TEXT PRIMARY KEY,   -- siempre en MAYUSCULA
      network_id   TEXT UNIQUE NOT NULL,
      subnet_index INTEGER,            -- indice de subred /24 dedicada (10.66.<indice>.0/24)
      created_at   TEXT NOT NULL
    );
  `);

  // migracion para bases sqlite creadas antes de que existiera subnet_index
  try {
    sqliteDb.run('ALTER TABLE clientes ADD COLUMN subnet_index INTEGER');
  } catch (e) {
    // la columna ya existe (tabla recien creada arriba, o ya migrada antes) — ignorar
  }

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

function upsertClienteSqlite(clienteUpper, networkId, subnetIndex) {
  if (!sqliteDb || !clienteUpper) return;
  sqliteDb.run(
    `INSERT INTO clientes (cliente, network_id, subnet_index, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(cliente) DO UPDATE SET network_id = excluded.network_id, subnet_index = excluded.subnet_index`,
    [clienteUpper, networkId, subnetIndex, new Date().toISOString()]
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

  const clientesRes = sqliteDb.exec('SELECT cliente, network_id, subnet_index FROM clientes');
  if (clientesRes.length) {
    for (const [cliente, networkId, subnetIndex] of clientesRes[0].values) {
      db.clientes[cliente] = {
        networkId,
        subnetIndex: subnetIndex == null ? undefined : subnetIndex,
        createdAt: new Date().toISOString(),
      };
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
  for (const [cliente, entry] of Object.entries(db.clientes || {})) {
    if (entry && typeof entry === 'object') {
      upsertClienteSqlite(cliente, entry.networkId, entry.subnetIndex);
    }
  }
  for (const node of Object.values(db.nodes)) {
    upsertNodeSqlite(node);
  }
  persistSqlite();
}

// ────────────────────────────────────────────────────────────────────────
// IDs unicos
// ────────────────────────────────────────────────────────────────────────

// "ID nodal" — unico por equipo. Formato: EC + 8 caracteres random
// alfanumericos (mayusculas + digitos) = 10 caracteres total. ej: EC7K2P9X4B
function genNodeId() {
  return 'EC' + randomAlnum(8);
}

// "ID de red" — unico por cliente. 16 caracteres random alfanumericos
// (mayusculas + digitos). ej: 9F3K7B2E1QX8M0LZ
function genNetworkId() {
  return randomAlnum(16);
}

// genera un string random de `len` caracteres usando [A-Z0-9]
function randomAlnum(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

// El "while" es lo que garantiza que nunca se repita un ID: no es que la
// probabilidad de choque sea baja y listo, es que si por casualidad
// generamos uno que ya existe, se descarta y se genera otro hasta que sea
// unico. Mismo mecanismo se usa para el ID de red y para el indice de
// subred de cada cliente.
function uniqueNodeId(db) {
  const used = new Set(Object.values(db.nodes).map((n) => n.nodeId).filter(Boolean));
  let id;
  do { id = genNodeId(); } while (used.has(id));
  return id;
}

// dado un texto de cliente, devuelve { clienteUpper, networkId, subnetPrefix }.
// Si el cliente ya existia (comparando en MAYUSCULA) reutiliza su mismo id
// de red y su misma subred. Si es un cliente nuevo, le genera un id de red
// y una subred /24 propia (10.66.<indice>.0/24) que todavia no este en uso.
function resolveCliente(db, clienteRaw) {
  const clienteUpper = (clienteRaw || '').trim().toUpperCase();
  if (!clienteUpper) {
    return { clienteUpper: '', networkId: '', subnetPrefix: subnetPrefixFor(DEFAULT_SUBNET_INDEX) };
  }

  if (!db.clientes) db.clientes = {};

  let entry = db.clientes[clienteUpper];
  if (!entry) {
    const usedNetworkIds = new Set(
      Object.values(db.clientes).map((c) => (typeof c === 'object' ? c.networkId : c))
    );
    let networkId;
    do { networkId = genNetworkId(); } while (usedNetworkIds.has(networkId));

    const usedSubnets = new Set(
      Object.values(db.clientes)
        .map((c) => (typeof c === 'object' ? c.subnetIndex : undefined))
        .filter((i) => i !== undefined && i !== null)
    );
    let subnetIndex = CLIENT_SUBNET_FIRST;
    while (usedSubnets.has(subnetIndex)) {
      subnetIndex++;
      if (subnetIndex > CLIENT_SUBNET_LAST) {
        throw new Error(`sin subredes libres para clientes nuevos (maximo ${CLIENT_SUBNET_LAST} clientes)`);
      }
    }

    entry = { networkId, subnetIndex, createdAt: new Date().toISOString() };
    db.clientes[clienteUpper] = entry;
    upsertClienteSqlite(clienteUpper, networkId, subnetIndex);
  }

  return {
    clienteUpper,
    networkId: entry.networkId,
    subnetPrefix: subnetPrefixFor(entry.subnetIndex),
  };
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

  let migrated = false;

  // ── migracion 1: clientes en formato viejo (string = solo el networkId)
  // pasan al formato nuevo { networkId, subnetIndex, createdAt }, y cada
  // cliente existente recibe una subred /24 propia que antes no tenia. ──
  const usedSubnetIdx = new Set(
    Object.values(db.clientes)
      .filter((c) => c && typeof c === 'object' && c.subnetIndex != null)
      .map((c) => c.subnetIndex)
  );
  let nextSubnetIdx = CLIENT_SUBNET_FIRST;
  function takeNextSubnetIdx() {
    while (usedSubnetIdx.has(nextSubnetIdx)) nextSubnetIdx++;
    if (nextSubnetIdx > CLIENT_SUBNET_LAST) {
      throw new Error(`sin subredes libres para migrar clientes (maximo ${CLIENT_SUBNET_LAST})`);
    }
    usedSubnetIdx.add(nextSubnetIdx);
    return nextSubnetIdx++;
  }

  for (const [cliente, val] of Object.entries(db.clientes)) {
    if (typeof val === 'string') {
      db.clientes[cliente] = {
        networkId: val,
        subnetIndex: takeNextSubnetIdx(),
        createdAt: new Date().toISOString(),
      };
      migrated = true;
    } else if (val && typeof val === 'object' && val.subnetIndex == null) {
      // cliente ya en formato nuevo pero sin subred asignada todavia
      val.subnetIndex = takeNextSubnetIdx();
      migrated = true;
    }
  }

  // ── migracion 2: nodos ──
  // - sin "cliente": se les agrega vacio
  // - "cliente" en minuscula: se pasa a mayuscula
  // - sin "nodeId": se les asigna uno unico (id nodal)
  // - con cliente asignado pero cuya IP no cae dentro de la subred de ese
  //   cliente (nodos viejos, de antes de que existieran las subredes por
  //   cliente): se les reasigna la IP a la subred que corresponde.
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

    if (node.cliente) {
      const entry = db.clientes[node.cliente];
      const resolved = entry
        ? { networkId: entry.networkId, subnetPrefix: subnetPrefixFor(entry.subnetIndex) }
        : resolveCliente(db, node.cliente); // fallback por si el cliente no existia todavia

      if (node.networkId !== resolved.networkId) {
        node.networkId = resolved.networkId;
        migrated = true;
      }

      const currentPrefix = node.ip ? node.ip.slice(0, node.ip.lastIndexOf('.') + 1) : null;
      if (node.ip && currentPrefix !== resolved.subnetPrefix) {
        node.ip = nextFreeIPInSubnet(db, resolved.subnetPrefix);
        migrated = true;
      }
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

  const db = loadDB(); // corre migraciones (ids nodales, ids de red, subredes, etc.)
  syncAllToSqlite(db); // deja el sqlite espejado con el JSON ya migrado

  console.log('[vpn-nodes] DB lista (json + sqlite) en', DATA_DIR);
}

// busca la primer IP libre dentro de una subred /24 puntual (ej: "10.66.3.")
function nextFreeIPInSubnet(db, prefix) {
  const used = new Set(Object.values(db.nodes).map((n) => n.ip));
  for (let i = FIRST_HOST; i <= LAST_HOST; i++) {
    const candidate = prefix + i;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`sin IPs libres en la subred ${prefix}0/24`);
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
    // equipo nuevo: todavia no tiene cliente, asi que arranca en la
    // subred por defecto 10.66.0.0/24 hasta que lo asignen desde el panel.
    node = {
      id: machineId,
      nodeId: uniqueNodeId(db), // ID nodal — unico por equipo, se asigna una sola vez
      name: defaultName(machineId),
      ip: nextFreeIPInSubnet(db, subnetPrefixFor(DEFAULT_SUBNET_INDEX)),
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

  // networkId viaja al controller para que pueda aislar el trafico: solo
  // relayea paquetes entre equipos del mismo cliente. Va vacio ("") para
  // equipos sin cliente asignado todavia.
  res.json({
    ip: node.ip,
    name: node.name,
    enabled: !!node.enabled,
    nodeId: node.nodeId,
    networkId: node.networkId || '',
  });
});

// ─── Router "admin": lo usa el panel React, protegido por requireAuth ──────
// (requireAuth ya se aplica solo, porque index.js monta esto bajo /api/...)
const adminRouter = express.Router();

adminRouter.get('/', (req, res) => {
  const db = loadDB();
  res.json(Object.values(db.nodes));
});

// ── Clientes como entidad propia (no dependen de que exista un equipo) ──

// lista todos los clientes que existen, tengan o no equipos asignados
// todavia — asi el panel puede mostrar una tarjeta vacia para un cliente
// recien creado.
adminRouter.get('/clientes', (req, res) => {
  const db = loadDB();
  const clientes = Object.entries(db.clientes || {}).map(([cliente, entry]) => ({
    cliente,
    networkId: entry.networkId,
    subnetIndex: entry.subnetIndex,
    subnetPrefix: subnetPrefixFor(entry.subnetIndex),
    createdAt: entry.createdAt,
  }));
  res.json(clientes);
});

// crea un cliente nuevo (le genera su ID de red y su subred /24 propia)
// sin necesitar que exista ningun equipo todavia. Si ya existia un
// cliente con ese mismo nombre (comparando en MAYUSCULA), no crea uno
// duplicado: devuelve el que ya estaba.
adminRouter.post('/clientes', async (req, res) => {
  const { cliente } = req.body || {};
  if (!cliente || !cliente.trim()) {
    return res.status(400).json({ error: 'nombre de cliente requerido' });
  }

  const db = loadDB();
  let subnetPrefix;
  let clienteUpper;
  let networkId;
  try {
    ({ clienteUpper, networkId, subnetPrefix } = resolveCliente(db, cliente));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  await saveDB(db);
  persistSqlite();

  res.json({ cliente: clienteUpper, networkId, subnetPrefix });
});

// borra un cliente — solo si ya no tiene ningun equipo asignado, para no
// dejar equipos "colgados" apuntando a un networkId que ya no existe.
adminRouter.delete('/clientes/:cliente', async (req, res) => {
  const clienteUpper = decodeURIComponent(req.params.cliente).trim().toUpperCase();
  const db = loadDB();

  if (!db.clientes || !db.clientes[clienteUpper]) {
    return res.status(404).json({ error: 'cliente no encontrado' });
  }

  const tieneEquipos = Object.values(db.nodes).some((n) => n.cliente === clienteUpper);
  if (tieneEquipos) {
    return res.status(400).json({ error: 'este cliente todavia tiene equipos asignados — reasignalos o borralos primero' });
  }

  delete db.clientes[clienteUpper];
  await saveDB(db);
  if (sqliteDb) {
    sqliteDb.run('DELETE FROM clientes WHERE cliente = ?', [clienteUpper]);
    persistSqlite();
  }

  res.json({ ok: true });
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
    // con ese mismo nombre, se reutiliza su id de red y su subred; si es
    // nuevo, se le genera un id de red y una subred /24 propia.
    const oldPrefix = node.ip ? node.ip.slice(0, node.ip.lastIndexOf('.') + 1) : null;
    const { clienteUpper, networkId, subnetPrefix } = resolveCliente(db, cliente);

    node.cliente = clienteUpper;
    node.networkId = networkId;

    // si cambio de cliente (o se le saco el cliente), cambia de subred —
    // le reasignamos IP dentro de la subred que corresponda. El equipo va
    // a tomar la IP nueva solito la proxima vez que le mande "hello" al
    // controller (no hace falta reiniciar nada del lado del cliente).
    if (oldPrefix !== subnetPrefix) {
      node.ip = nextFreeIPInSubnet(db, subnetPrefix);
    }
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