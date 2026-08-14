// vpn-nodes.server.js
//
// CAMBIO IMPORTANTE (anterior): un equipo ahora puede pertenecer a VARIOS
// clientes al mismo tiempo. Cada nodo tiene un arreglo "clientes":
// [{ cliente, networkId, ip }, ...], una entrada por cada cliente al que
// fue agregado desde el panel. El nodeId (identidad del equipo) es
// SIEMPRE el mismo sin importar a cuantos clientes pertenezca — eso
// nunca cambia.
//
// La asignacion/desasignacion de clientes se hace SOLO desde estos dos
// endpoints (el "boton" del panel los llama), nunca desde el equipo. Asi
// un dispositivo bloqueado no tiene forma de auto-agregarse a una red
// aunque tenga acceso fisico a la maquina.
//
// CAMBIO NUEVO (este): el bridge ahora manda, ademas de "machineId":
//   - "publicIp": la IP publica real del equipo (la saca el controller
//     del socket UDP, el nodo no la puede falsear) — se guarda SIEMPRE
//     que llega, se pisa con la mas reciente.
//   - "netInfo": { gatewayIp, routerName } opcional — el nodo lo manda
//     UNA sola vez en su vida, o cuando este servidor le pide
//     explicitamente "requestNetInfo: true" en la respuesta.
// La politica de "cuando pedirlo" vive en el endpoint /register: se pide
// mientras el nodo nunca haya mandado netInfo, o mientras el panel haya
// marcado netInfoRequestPending = true a mano (endpoint nuevo mas abajo).
// Nada de esto reemplaza ni afecta clientes/assignments/nodeId.
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

const SUBNET_BASE = '10.66.';
const DEFAULT_SUBNET_INDEX = 0;
const CLIENT_SUBNET_FIRST = 1;
const CLIENT_SUBNET_LAST = 254;
const FIRST_HOST = 2;
const LAST_HOST = 254;

function subnetPrefixFor(subnetIndex) {
  return `${SUBNET_BASE}${subnetIndex}.`;
}

let writeQueue = Promise.resolve();

// ────────────────────────────────────────────────────────────────────────
// SQLITE (respaldo en espejo)
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
      cliente      TEXT PRIMARY KEY,
      network_id   TEXT UNIQUE NOT NULL,
      subnet_index INTEGER,
      created_at   TEXT NOT NULL
    );
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS nodos (
      machine_id  TEXT PRIMARY KEY,
      node_id     TEXT UNIQUE NOT NULL,
      name        TEXT,
      uuid        TEXT,
      mac         TEXT,
      enabled     INTEGER,
      created_at  TEXT,
      last_seen   TEXT
    );
  `);

  // columnas nuevas: si la tabla "nodos" ya existia de antes (produccion),
  // CREATE TABLE IF NOT EXISTS no las agrega solo — hace falta ALTER TABLE.
  // Envuelto en try/catch porque sql.js tira error si la columna ya existe
  // (por ejemplo, en un arranque despues del primero con este codigo).
  for (const alter of [
    'ALTER TABLE nodos ADD COLUMN last_public_ip TEXT',
    'ALTER TABLE nodos ADD COLUMN net_info TEXT',
    'ALTER TABLE nodos ADD COLUMN net_info_at TEXT',
    'ALTER TABLE nodos ADD COLUMN net_info_pending INTEGER',
  ]) {
    try { sqliteDb.run(alter); } catch (e) { /* columna ya existe, ignorar */ }
  }

  // tabla nueva: relacion muchos-a-muchos entre nodos y clientes, con la
  // IP puntual que le corresponde a ESE nodo dentro de ESE cliente.
  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS node_clientes (
      machine_id  TEXT NOT NULL,
      cliente     TEXT NOT NULL,
      network_id  TEXT NOT NULL,
      ip          TEXT NOT NULL,
      PRIMARY KEY (machine_id, cliente)
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
    `INSERT INTO nodos (machine_id, node_id, name, uuid, mac, enabled, created_at, last_seen,
                         last_public_ip, net_info, net_info_at, net_info_pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET
       node_id = excluded.node_id, name = excluded.name, uuid = excluded.uuid,
       mac = excluded.mac, enabled = excluded.enabled, last_seen = excluded.last_seen,
       last_public_ip = excluded.last_public_ip, net_info = excluded.net_info,
       net_info_at = excluded.net_info_at, net_info_pending = excluded.net_info_pending`,
    [node.id, node.nodeId, node.name || '', node.uuid || '', node.mac || '',
     node.enabled ? 1 : 0, node.createdAt || new Date().toISOString(), node.lastSeen || null,
     node.lastPublicIp || null,
     node.netInfo ? JSON.stringify(node.netInfo) : null,
     node.netInfoAt || null,
     node.netInfoRequestPending ? 1 : 0]
  );

  // relacion muchos-a-muchos: se borra todo lo viejo de este equipo y se
  // vuelve a insertar la lista actual completa — mas simple y seguro que
  // tratar de calcular un diff, y son pocas filas por equipo.
  sqliteDb.run('DELETE FROM node_clientes WHERE machine_id = ?', [node.id]);
  for (const c of node.clientes || []) {
    sqliteDb.run(
      'INSERT INTO node_clientes (machine_id, cliente, network_id, ip) VALUES (?, ?, ?, ?)',
      [node.id, c.cliente, c.networkId, c.ip]
    );
  }
}

function deleteNodeSqlite(machineId) {
  if (!sqliteDb) return;
  sqliteDb.run('DELETE FROM nodos WHERE machine_id = ?', [machineId]);
  sqliteDb.run('DELETE FROM node_clientes WHERE machine_id = ?', [machineId]);
}

function countNodesSqlite() {
  if (!sqliteDb) return 0;
  const res = sqliteDb.exec('SELECT COUNT(*) AS c FROM nodos');
  return res.length ? res[0].values[0][0] : 0;
}

function restoreJsonFromSqlite() {
  const db = { nodes: {}, clientes: {} };

  const clientesRes = sqliteDb.exec('SELECT cliente, network_id, subnet_index FROM clientes');
  if (clientesRes.length) {
    for (const [cliente, networkId, subnetIndex] of clientesRes[0].values) {
      db.clientes[cliente] = { networkId, subnetIndex: subnetIndex == null ? undefined : subnetIndex, createdAt: new Date().toISOString() };
    }
  }

  const nodosRes = sqliteDb.exec(`
    SELECT machine_id, node_id, name, uuid, mac, enabled, created_at, last_seen,
           last_public_ip, net_info, net_info_at, net_info_pending
    FROM nodos
  `);
  const nodeClientesRes = sqliteDb.exec('SELECT machine_id, cliente, network_id, ip FROM node_clientes');
  const clientesPorNodo = {};
  if (nodeClientesRes.length) {
    for (const [machineId, cliente, networkId, ip] of nodeClientesRes[0].values) {
      (clientesPorNodo[machineId] = clientesPorNodo[machineId] || []).push({ cliente, networkId, ip });
    }
  }

  if (nodosRes.length) {
    for (const row of nodosRes[0].values) {
      const [machineId, nodeId, name, uuid, mac, enabled, createdAt, lastSeen,
             lastPublicIp, netInfoRaw, netInfoAt, netInfoPending] = row;
      let netInfo = null;
      if (netInfoRaw) {
        try { netInfo = JSON.parse(netInfoRaw); } catch (e) { netInfo = null; }
      }
      db.nodes[machineId] = {
        id: machineId, nodeId, name, uuid: uuid || '', mac: mac || '',
        enabled, createdAt, lastSeen: lastSeen || null,
        clientes: clientesPorNodo[machineId] || [],
        lastPublicIp: lastPublicIp || undefined,
        netInfo: netInfo || undefined,
        netInfoAt: netInfoAt || undefined,
        netInfoRequestPending: !!netInfoPending,
      };
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function syncAllToSqlite(db) {
  for (const [cliente, entry] of Object.entries(db.clientes || {})) {
    if (entry && typeof entry === 'object') upsertClienteSqlite(cliente, entry.networkId, entry.subnetIndex);
  }
  for (const node of Object.values(db.nodes)) upsertNodeSqlite(node);
  persistSqlite();
}

// ────────────────────────────────────────────────────────────────────────
// IDs unicos
// ────────────────────────────────────────────────────────────────────────
function genNodeId() { return 'EC' + randomAlnum(8); }
function genNetworkId() { return randomAlnum(16); }

function randomAlnum(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function uniqueNodeId(db) {
  const used = new Set(Object.values(db.nodes).map((n) => n.nodeId).filter(Boolean));
  let id;
  do { id = genNodeId(); } while (used.has(id));
  return id;
}

// dado un texto de cliente, devuelve/crea su entrada global (networkId +
// subred propia). No toca ningun nodo — eso lo hacen addClienteToNode /
// removeClienteFromNode mas abajo.
function resolveCliente(db, clienteRaw) {
  const clienteUpper = (clienteRaw || '').trim().toUpperCase();
  if (!clienteUpper) throw new Error('nombre de cliente vacio');

  if (!db.clientes) db.clientes = {};

  let entry = db.clientes[clienteUpper];
  if (!entry) {
    const usedNetworkIds = new Set(Object.values(db.clientes).map((c) => (typeof c === 'object' ? c.networkId : c)));
    let networkId;
    do { networkId = genNetworkId(); } while (usedNetworkIds.has(networkId));

    const usedSubnets = new Set(
      Object.values(db.clientes).map((c) => (typeof c === 'object' ? c.subnetIndex : undefined)).filter((i) => i != null)
    );
    let subnetIndex = CLIENT_SUBNET_FIRST;
    while (usedSubnets.has(subnetIndex)) {
      subnetIndex++;
      if (subnetIndex > CLIENT_SUBNET_LAST) throw new Error(`sin subredes libres (maximo ${CLIENT_SUBNET_LAST} clientes)`);
    }

    entry = { networkId, subnetIndex, createdAt: new Date().toISOString() };
    db.clientes[clienteUpper] = entry;
    upsertClienteSqlite(clienteUpper, networkId, subnetIndex);
  }

  return { clienteUpper, networkId: entry.networkId, subnetPrefix: subnetPrefixFor(entry.subnetIndex) };
}

// busca la primer IP libre dentro de una subred /24, mirando las IPs ya
// usadas por CUALQUIER equipo en CUALQUIERA de sus membresias.
function nextFreeIPInSubnet(db, prefix) {
  const used = new Set();
  for (const node of Object.values(db.nodes)) {
    for (const c of node.clientes || []) {
      if (c.ip && c.ip.startsWith(prefix)) used.add(c.ip);
    }
  }
  for (let i = FIRST_HOST; i <= LAST_HOST; i++) {
    const candidate = prefix + i;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`sin IPs libres en la subred ${prefix}0/24`);
}

// addClienteToNode: agrega (si no estaba ya) una membresia de "cliente"
// al nodo, con su propia IP dentro de la subred de ese cliente. Si el
// nodo YA pertenecia a ese cliente, no hace nada (idempotente) y devuelve
// la membresia existente tal cual estaba.
function addClienteToNode(db, node, clienteRaw) {
  const { clienteUpper, networkId, subnetPrefix } = resolveCliente(db, clienteRaw);

  if (!node.clientes) node.clientes = [];
  const existing = node.clientes.find((c) => c.cliente === clienteUpper);
  if (existing) return existing;

  const ip = nextFreeIPInSubnet(db, subnetPrefix);
  const membership = { cliente: clienteUpper, networkId, ip };
  node.clientes.push(membership);
  return membership;
}

// removeClienteFromNode: saca la membresia de ese cliente del nodo (si
// existia). La IP queda libre automaticamente para el proximo equipo,
// porque nextFreeIPInSubnet solo mira las membresias ACTUALES.
function removeClienteFromNode(node, clienteRaw) {
  const clienteUpper = (clienteRaw || '').trim().toUpperCase();
  if (!node.clientes) return false;
  const before = node.clientes.length;
  node.clientes = node.clientes.filter((c) => c.cliente !== clienteUpper);
  return node.clientes.length !== before;
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

  const usedSubnetIdx = new Set(
    Object.values(db.clientes).filter((c) => c && typeof c === 'object' && c.subnetIndex != null).map((c) => c.subnetIndex)
  );
  let nextSubnetIdx = CLIENT_SUBNET_FIRST;
  function takeNextSubnetIdx() {
    while (usedSubnetIdx.has(nextSubnetIdx)) nextSubnetIdx++;
    if (nextSubnetIdx > CLIENT_SUBNET_LAST) throw new Error(`sin subredes libres para migrar (maximo ${CLIENT_SUBNET_LAST})`);
    usedSubnetIdx.add(nextSubnetIdx);
    return nextSubnetIdx++;
  }

  for (const [cliente, val] of Object.entries(db.clientes)) {
    if (typeof val === 'string') {
      db.clientes[cliente] = { networkId: val, subnetIndex: takeNextSubnetIdx(), createdAt: new Date().toISOString() };
      migrated = true;
    } else if (val && typeof val === 'object' && val.subnetIndex == null) {
      val.subnetIndex = takeNextSubnetIdx();
      migrated = true;
    }
  }

  // migracion clave: nodos con el esquema VIEJO (cliente/networkId/ip
  // singulares) pasan a tener "clientes: [ ... ]" con esa unica membresia
  // adentro (si tenian cliente asignado), y se borran los campos viejos.
  for (const node of Object.values(db.nodes)) {
    if (!node.nodeId) {
      node.nodeId = uniqueNodeId(db);
      migrated = true;
    }

    if (!Array.isArray(node.clientes)) {
      const clientes = [];
      if (node.cliente) {
        const upper = node.cliente.trim().toUpperCase();
        try {
          const entry = db.clientes[upper] || resolveCliente(db, upper);
          const networkId = entry.networkId;
          const ip = node.ip || nextFreeIPInSubnet(db, subnetPrefixFor(entry.subnetIndex ?? DEFAULT_SUBNET_INDEX));
          clientes.push({ cliente: upper, networkId, ip });
        } catch (e) {
          console.error('[vpn-nodes] no se pudo migrar cliente de', node.id, ':', e.message);
        }
      }
      node.clientes = clientes;
      delete node.cliente;
      delete node.networkId;
      delete node.ip;
      migrated = true;
    }
  }

  if (migrated) fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  return db;
}

function saveDB(db) {
  writeQueue = writeQueue.then(() => fs.promises.writeFile(DB_PATH, JSON.stringify(db, null, 2)));
  return writeQueue;
}

async function initVpnNodesDB() {
  await initSqlite();

  const jsonExists = fs.existsSync(DB_PATH);
  const jsonNodeCount = jsonExists ? Object.keys(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')).nodes || {}).length : 0;

  if (jsonNodeCount === 0 && countNodesSqlite() > 0) {
    console.log('[vpn-nodes] vpn_nodes.json vacio/ausente, restaurando desde sqlite…');
    restoreJsonFromSqlite();
  }

  const db = loadDB();
  syncAllToSqlite(db);

  console.log('[vpn-nodes] DB lista (json + sqlite) en', DATA_DIR);
}

function defaultName(machineId) {
  return 'nodo-' + machineId.slice(-6).toLowerCase();
}

// isPlausibleIp: chequeo simple para no guardar cualquier cosa como
// publicIp si algun dia llega un valor raro. Es solo informativo (nunca
// se usa para logica de seguridad — la seguridad de identidad la da la
// firma que verifica el controller, no esto).
function isPlausibleIp(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

// ─── Router "bridge": lo llama vpn-registry-bridge.js desde la VM ──────────
const bridgeRouter = express.Router();

bridgeRouter.post('/register', async (req, res) => {
  const key = req.headers['x-bridge-key'];
  if (key !== BRIDGE_SECRET) return res.status(401).json({ error: 'bridge key invalida' });

  const { machineId, publicIp, netInfo } = req.body || {};
  if (!machineId || typeof machineId !== 'string') return res.status(400).json({ error: 'machineId requerido' });

  const db = loadDB();
  let node = db.nodes[machineId];

  if (!node) {
    // equipo nuevo: nace SIN clientes asignados (clientes: []) y
    // bloqueado — hasta que alguien lo autorice y lo agregue a algun
    // cliente desde el panel, no puede hablar con nadie.
    node = {
      id: machineId,
      nodeId: uniqueNodeId(db),
      name: defaultName(machineId),
      clientes: [],
      enabled: 0,
      createdAt: new Date().toISOString(),
    };
    db.nodes[machineId] = node;
  }
  node.lastSeen = new Date().toISOString();

  // publicIp: se guarda siempre que llega, se pisa con la mas reciente.
  // Es solo informativo (visibilidad en el panel) — nunca se usa para
  // decidir autorizacion, eso lo sigue haciendo "enabled", y la firma la
  // verifica el controller antes de que el pedido llegue aca.
  if (isPlausibleIp(publicIp)) {
    node.lastPublicIp = publicIp;
  }

  // netInfo: si vino en este registro, se guarda y ya no hace falta
  // pedirlo mas. Si nunca vino y el nodo tampoco tiene uno guardado de
  // antes, se sigue pidiendo en cada registro (requestNetInfo=true) hasta
  // que el nodo consiga mandarlo una vez. El panel puede ademas forzar un
  // pedido puntual con netInfoRequestPending (endpoint mas abajo).
  if (netInfo && typeof netInfo === 'object') {
    node.netInfo = {
      gatewayIp: typeof netInfo.gatewayIp === 'string' ? netInfo.gatewayIp : undefined,
      routerName: typeof netInfo.routerName === 'string' ? netInfo.routerName : undefined,
    };
    node.netInfoAt = new Date().toISOString();
    node.netInfoRequestPending = false;
  }

  const requestNetInfo = !node.netInfo || !!node.netInfoRequestPending;

  await saveDB(db);
  upsertNodeSqlite(node);
  persistSqlite();

  res.json({
    name: node.name,
    enabled: !!node.enabled,
    nodeId: node.nodeId,
    assignments: (node.clientes || []).map((c) => ({ networkId: c.networkId, ip: c.ip })),
    requestNetInfo,
  });
});

// ─── Router "admin": lo usa el panel React ──────────────────────────────
const adminRouter = express.Router();

adminRouter.get('/', (req, res) => {
  const db = loadDB();
  res.json(Object.values(db.nodes));
});

adminRouter.get('/clientes', (req, res) => {
  const db = loadDB();
  const clientes = Object.entries(db.clientes || {}).map(([cliente, entry]) => ({
    cliente, networkId: entry.networkId, subnetIndex: entry.subnetIndex,
    subnetPrefix: subnetPrefixFor(entry.subnetIndex), createdAt: entry.createdAt,
  }));
  res.json(clientes);
});

adminRouter.post('/clientes', async (req, res) => {
  const { cliente } = req.body || {};
  if (!cliente || !cliente.trim()) return res.status(400).json({ error: 'nombre de cliente requerido' });

  const db = loadDB();
  let out;
  try {
    out = resolveCliente(db, cliente);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  await saveDB(db);
  persistSqlite();
  res.json({ cliente: out.clienteUpper, networkId: out.networkId, subnetPrefix: out.subnetPrefix });
});

adminRouter.delete('/clientes/:cliente', async (req, res) => {
  const clienteUpper = decodeURIComponent(req.params.cliente).trim().toUpperCase();
  const db = loadDB();
  if (!db.clientes || !db.clientes[clienteUpper]) return res.status(404).json({ error: 'cliente no encontrado' });

  const tieneEquipos = Object.values(db.nodes).some((n) => (n.clientes || []).some((c) => c.cliente === clienteUpper));
  if (tieneEquipos) return res.status(400).json({ error: 'este cliente todavia tiene equipos asignados — sacaselos primero' });

  delete db.clientes[clienteUpper];
  await saveDB(db);
  if (sqliteDb) { sqliteDb.run('DELETE FROM clientes WHERE cliente = ?', [clienteUpper]); persistSqlite(); }
  res.json({ ok: true });
});

// ── EL BOTON: agregar un cliente mas a un equipo (no reemplaza los que ya tenia) ──
adminRouter.post('/:machineId/clientes', async (req, res) => {
  const { machineId } = req.params;
  const { cliente } = req.body || {};
  if (!cliente || !cliente.trim()) return res.status(400).json({ error: 'nombre de cliente requerido' });

  const db = loadDB();
  const node = db.nodes[machineId];
  if (!node) return res.status(404).json({ error: 'nodo no encontrado' });

  let membership;
  try {
    membership = addClienteToNode(db, node, cliente);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  await saveDB(db);
  upsertNodeSqlite(node);
  persistSqlite();
  res.json({ node, membership });
});

// ── sacarle un cliente puntual a un equipo (no toca los demas que tenga) ──
adminRouter.delete('/:machineId/clientes/:cliente', async (req, res) => {
  const { machineId } = req.params;
  const cliente = decodeURIComponent(req.params.cliente);

  const db = loadDB();
  const node = db.nodes[machineId];
  if (!node) return res.status(404).json({ error: 'nodo no encontrado' });

  const removed = removeClienteFromNode(node, cliente);
  if (!removed) return res.status(404).json({ error: 'ese equipo no pertenecia a ese cliente' });

  await saveDB(db);
  upsertNodeSqlite(node);
  persistSqlite();
  res.json(node);
});

// ── NUEVO: pedirle a un equipo puntual que mande netInfo en su proximo
// registro, sin importar si ya lo habia mandado antes alguna vez. Util
// para re-chequear conectividad/ISP de un equipo especifico bajo pedido.
adminRouter.post('/:machineId/request-netinfo', async (req, res) => {
  const { machineId } = req.params;
  const db = loadDB();
  const node = db.nodes[machineId];
  if (!node) return res.status(404).json({ error: 'nodo no encontrado' });

  node.netInfoRequestPending = true;

  await saveDB(db);
  upsertNodeSqlite(node);
  persistSqlite();
  res.json({ ok: true, node });
});

adminRouter.put('/:machineId', async (req, res) => {
  const { machineId } = req.params;
  const { name, uuid, mac, enabled } = req.body || {};

  const db = loadDB();
  const node = db.nodes[machineId];
  if (!node) return res.status(404).json({ error: 'nodo no encontrado' });

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'nombre invalido' });
    node.name = name.trim();
  }
  if (uuid !== undefined) node.uuid = uuid.trim();
  if (mac !== undefined) node.mac = mac.trim();
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