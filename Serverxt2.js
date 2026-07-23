const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.sqlite');
let db;

// ─── DB INIT ────────────────────────────────────────────────────────────────
async function initDB() {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mac         TEXT UNIQUE NOT NULL,
      host        TEXT,
      arch        TEXT,
      os          TEXT,
      zerotier_id TEXT,
      isp         TEXT,
      city        TEXT,
      location    TEXT,
      first_seen  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] SQLite initialized — single table: nodes');
}

function getAllNodes() {
  if (!db) throw new Error('DB not initialized');
  return db.prepare('SELECT * FROM nodes').all();
}

// INSERT only if MAC is new; UPDATE only NULL fields
function upsertNode(mac, fields) {
  const existing = db.prepare('SELECT * FROM nodes WHERE mac = ?').get(mac);
  if (!existing) {
    db.prepare(`
      INSERT INTO nodes (mac, host, arch, os, zerotier_id, isp, city, location)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mac,
      fields.host        || null,
      fields.arch        || null,
      fields.os          || null,
      fields.zerotier_id || null,
      fields.isp         || null,
      fields.city        || null,
      fields.location    || null
    );
    console.log(`[DB] New node inserted: ${mac}`);
  } else {
    // Only fill NULL fields — never overwrite existing data
    const updates = [];
    const vals = [];
    for (const key of ['host', 'arch', 'os', 'zerotier_id', 'isp', 'city', 'location']) {
      if (existing[key] === null && fields[key] != null) {
        updates.push(`${key} = ?`);
        vals.push(fields[key]);
      }
    }
    if (updates.length > 0) {
      vals.push(mac);
      db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE mac = ?`).run(...vals);
      console.log(`[DB] Node updated (filled nulls): ${mac}`);
    }
  }
}

// ─── RAM STATE ──────────────────────────────────────────────────────────────
// nodesLive holds ONLY real-time data — no persistence
const nodesLive = {};

// Timeout in ms — configurable via env or default 30s
const TIMEOUT_MS = parseInt(process.env.NODE_TIMEOUT_MS || '30000');

function setNodeLive(mac, payload) {
  const now = Date.now();
  const parsed = parsePayload(payload);
  const locations = extractLocations(payload);

  if (!nodesLive[mac]) {
    nodesLive[mac] = {
      mac,
      lastUpdate: now,
      status: 'online',
      fullPayload: payload,
      parsed,
      locations
    };
  } else {
    nodesLive[mac].lastUpdate = now;
    nodesLive[mac].status = 'online';
    nodesLive[mac].fullPayload = payload;
    nodesLive[mac].parsed = parsed;
    nodesLive[mac].locations = locations;
  }
}

function cleanAndRecalculate() {
  const now = Date.now();
  for (const mac of Object.keys(nodesLive)) {
    const node = nodesLive[mac];
    const age = now - node.lastUpdate;
    if (age > TIMEOUT_MS) {
      node.status = 'offline';
      // Clear dynamic payload — keep only identity
      node.fullPayload = null;
      node.parsed = null;
    }
  }
}

// ─── PAYLOAD PARSING ────────────────────────────────────────────────────────
function parsePayload(payload) {
  if (!payload) return null;
  return {
    system:       payload.system       || null,
    network:      payload.network      || null,
    zerotier:     payload.network?.zerotier || null,
    connectivity: payload.connectivity || null,
    services:     payload.services     || null,
    external:     payload.external     || null
  };
}

function extractLocations(payload) {
  const networks = payload?.network?.zerotier?.networks || [];
  return networks.map(n => {
    const nameParts = n.name?.split(' ') || [];
    // Remove network_id prefix (first word if it looks like hex)
    const label = nameParts.slice(1).join(' ').trim() || n.name;
    return {
      id:        n.network_id,
      name:      label,
      rawName:   n.name,
      mac:       n.mac,
      status:    n.status,
      interface: n.interface,
      ip:        n.ip
    };
  });
}

// Extract only the persistable fields from a payload
function extractPersistableFields(mac, payload) {
  return {
    host:        payload?.system?.host               || null,
    arch:        payload?.system?.arch               || null,
    os:          payload?.system?.os                 || null,
    zerotier_id: payload?.network?.zerotier?.node_id || null,
    isp:         payload?.external?.isp              || null,
    city:        payload?.external?.city             || null,
    location:    extractLocations(payload).map(l => l.name).join(', ') || null
  };
}

// Expose current live state (called by broadcast timer)
function getLiveSnapshot() {
  return Object.values(nodesLive);
}

// ─── MQTT ENGINE ────────────────────────────────────────────────────────────
function startMQTT(broadcast) {
  const BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
  const TOPIC_PREFIX = 'Rasp/test/';

  const mqttOptions = {
    clientId:        'Cr4nos_XT2_' + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 5000,
    connectTimeout:  10000,
  };

  // Credenciales opcionales — definir en .env
  if (process.env.MQTT_USER) mqttOptions.username = process.env.MQTT_USER;
  if (process.env.MQTT_PASS) mqttOptions.password = process.env.MQTT_PASS;

  const client = mqtt.connect(BROKER, mqttOptions);

  client.on('connect', () => {
    console.log(`[MQTT] Connected to ${BROKER}`);
    client.subscribe('Rasp/test/#', (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err.message);
      else console.log('[MQTT] Subscribed to Rasp/test/#');
    });
  });

  client.on('message', (topic, message) => {
    // Filter: only Rasp/test/<MAC>
    if (!topic.startsWith(TOPIC_PREFIX)) return;
    const mac = topic.slice(TOPIC_PREFIX.length).trim();
    if (!mac || mac.includes('/')) return; // ignore sub-paths

    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (e) {
      console.warn(`[MQTT] Bad JSON from ${topic}`);
      return;
    }

    // Update RAM state
    setNodeLive(mac, payload);

    // Persist only allowed fields (never overwrite)
    const fields = extractPersistableFields(mac, payload);
    upsertNode(mac, fields);

    // Immediately broadcast update
    broadcast({ type: 'NODE_UPDATE', mac, node: nodesLive[mac] });
  });

  client.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
  });

  client.on('offline', () => {
    console.warn('[MQTT] Broker offline — reconnecting...');
  });

  // Periodic cleanup + broadcast (every 5s)
  setInterval(() => {
    cleanAndRecalculate();
    broadcast({ type: 'SNAPSHOT', nodes: getLiveSnapshot() });
  }, 5000);

  console.log(`[MQTT] Engine started — timeout: ${TIMEOUT_MS}ms`);
}

module.exports = { initDB, getAllNodes, startMQTT };