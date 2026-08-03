/**
 * mqtt-pty-bridge.js
 * ─────────────────────────────────────────────────────────────────────────
 * Módulo para la NUBE (index.js).
 * Traduce WebSocket (navegador) ⟷ MQTT (Nodo A), para que la página React
 * pueda abrir una terminal remota del Nodo A a través del broker MQTT.
 *
 * El navegador se conecta a:
 *   wss://<host>/ws/pty?nodeId=<id_del_nodo>&session=<id_sesion>&token=<jwt>
 *
 * Mensajes JSON que el navegador envía por WS:
 *   { type: "input",  data: "ls -la\n" }
 *   { type: "resize", cols: 120, rows: 32 }
 *   { type: "control", action: "create"|"close", cols, rows }
 *
 * Mensajes JSON que el bridge reenvía al navegador (vía WS):
 *   { type: "output", data: "..." }
 *   { type: "status", status: "ready"|"closed"|"timeout", exitCode? }
 *
 * USO en index.js:
 *   const { attachPtyBridge } = require('./mqtt-pty-bridge');
 *   attachPtyBridge(server, { jwtSecret: JWT_SECRET });
 *
 * Requiere: npm install mqtt ws jsonwebtoken
 */

const { WebSocketServer } = require("ws");
const mqtt = require("mqtt");
const jwt = require("jsonwebtoken");
const { URL } = require("url");

function attachPtyBridge(httpServer, opts = {}) {
  const {
    path = "/ws/pty",
    mqttUrl = process.env.MQTT_URL || "mqtt://localhost:1883",
    mqttUser = process.env.MQTT_USER,
    mqttPass = process.env.MQTT_PASS,
    jwtSecret = process.env.JWT_SECRET || "encodex-secret-change-me",
  } = opts;

  // Un único cliente MQTT compartido por todas las sesiones de terminal.
  const mqttClient = mqtt.connect(mqttUrl, {
    username: mqttUser,
    password: mqttPass,
    clientId: `cloud-pty-bridge-${Math.random().toString(16).slice(2)}`,
    reconnectPeriod: 2000,
  });

  mqttClient.on("connect", () => console.log(`[pty-bridge] MQTT conectado a ${mqttUrl}`));
  mqttClient.on("error", (err) => console.error("[pty-bridge] MQTT error:", err.message));

  // topicKey -> Set<ws>  (permite varios navegadores viendo la misma sesión, opcional)
  const subscribers = new Map();

  function topicOutput(nodeId, session) {
    return `agents/${nodeId}/pty/${session}/output`;
  }
  function topicStatus(nodeId, session) {
    return `agents/${nodeId}/pty/${session}/status`;
  }
  function topicInput(nodeId, session) {
    return `agents/${nodeId}/pty/${session}/input`;
  }
  function topicResize(nodeId, session) {
    return `agents/${nodeId}/pty/${session}/resize`;
  }
  function topicControl(nodeId, session) {
    return `agents/${nodeId}/pty/${session}/control`;
  }

  mqttClient.on("message", (topic, payload) => {
    const set = subscribers.get(topic);
    if (!set || set.size === 0) return;
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const kind = topic.endsWith("/output") ? "output" : "status";
    const out = JSON.stringify({ type: kind, ...msg });
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(out);
    }
  });

  function subscribe(topic, ws) {
    if (!subscribers.has(topic)) {
      subscribers.set(topic, new Set());
      mqttClient.subscribe(topic);
    }
    subscribers.get(topic).add(ws);
  }

  function unsubscribe(topic, ws) {
    const set = subscribers.get(topic);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      subscribers.delete(topic);
      mqttClient.unsubscribe(topic);
    }
  }

  function verifyToken(token) {
    if (!token) return null;
    try {
      return jwt.verify(token, jwtSecret);
    } catch {
      return null;
    }
  }

  // El WebSocket handshake es una petición HTTP normal, así que el navegador
  // manda la cookie 'token' igual que en cualquier fetch — no hace falta que
  // React la pase a mano. Se deja el query param solo como fallback de debug.
  function getCookieToken(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    const found = header.split(";").map((s) => s.trim()).find((s) => s.startsWith("token="));
    return found ? decodeURIComponent(found.slice("token=".length)) : null;
  }

  const wssPty = new WebSocketServer({ noServer: true });

  wssPty.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const nodeId = url.searchParams.get("nodeId");
    const session = url.searchParams.get("session") || `web_${Date.now()}`;
    const token = getCookieToken(req) || url.searchParams.get("token");

    // ── Autenticación: mismo JWT que usa el resto de la plataforma ──
    const user = verifyToken(token);
    if (!user) {
      ws.send(JSON.stringify({ type: "status", status: "unauthorized" }));
      ws.close();
      return;
    }
    if (!nodeId) {
      ws.send(JSON.stringify({ type: "status", status: "error", message: "Falta nodeId" }));
      ws.close();
      return;
    }

    console.log(`[pty-bridge] WS conectado: user=${user.username} nodeId=${nodeId} session=${session}`);

    const outTopic = topicOutput(nodeId, session);
    const statusTopic = topicStatus(nodeId, session);
    subscribe(outTopic, ws);
    subscribe(statusTopic, ws);

    // Pide crear (o adjuntarse a) la sesión PTY en el agente
    mqttClient.publish(topicControl(nodeId, session), JSON.stringify({ action: "create", cols: 80, rows: 24 }));

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "input") {
        mqttClient.publish(topicInput(nodeId, session), JSON.stringify({ data: msg.data }));
      } else if (msg.type === "resize") {
        mqttClient.publish(topicResize(nodeId, session), JSON.stringify({ cols: msg.cols, rows: msg.rows }));
      } else if (msg.type === "control") {
        mqttClient.publish(topicControl(nodeId, session), JSON.stringify({ action: msg.action, cols: msg.cols, rows: msg.rows }));
      }
    });

    ws.on("close", () => {
      unsubscribe(outTopic, ws);
      unsubscribe(statusTopic, ws);
      // No se cierra la sesión PTY automáticamente: así, si el usuario
      // recarga la página, retoma el mismo `session` y sigue donde estaba.
      // Si se prefiere cerrarla al desconectar, descomentar:
      // mqttClient.publish(topicControl(nodeId, session), JSON.stringify({ action: "close" }));
    });
  });

  return { wssPty, mqttClient };
}

module.exports = { attachPtyBridge };