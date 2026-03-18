/**
 * BABEL WebSocket + 静的ファイルサーバー
 *
 * リポジトリ構成（全部 main ルートに置く）:
 *   ├── server.js       ← このファイル
 *   ├── package.json
 *   └── index.html      ← クライアント（同じサーバーから配信）
 *
 * Render の設定:
 *   Build Command : npm install
 *   Start Command : node server.js
 *   Plan          : Free
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── HTTP: index.html を配信 + ヘルスチェック ──────────────────
const httpServer = http.createServer((req, res) => {

  // ヘルスチェック
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      connections: totalConnections(),
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }

  // それ以外は全部 index.html を返す（SPA的な扱い）
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('index.html not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ── WebSocket サーバー ─────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// rooms: Map<roomId, Map<clientId, { ws, name, lang }>>
const rooms = new Map();

function totalConnections() {
  let n = 0;
  for (const r of rooms.values()) n += r.size;
  return n;
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.size === 0) rooms.delete(roomId);
}

function broadcast(room, data, excludeId = null) {
  const json = JSON.stringify(data);
  for (const [id, client] of room) {
    if (id === excludeId) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(json);
    }
  }
}

wss.on('connection', (ws) => {
  let currentRoomId = null;
  let currentClientId = null;

  // ── Ping/Pong でゾンビ接続を検出 ──────────────────────
  // クライアントが25秒ごとにpingを送ってくる。
  // サーバー側は60秒以内にメッセージが来なければ強制切断する。
  let lastSeen = Date.now();
  const aliveCheck = setInterval(() => {
    if (Date.now() - lastSeen > 60000) {
      console.log(`[timeout] client=${currentClientId} — no message for 60s, terminating`);
      clearInterval(aliveCheck);
      ws.terminate();
    }
  }, 30000);

  ws.on('message', (raw) => {
    lastSeen = Date.now(); // メッセージが来るたびに更新

    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (!msg || typeof msg.type !== 'string') return;

    // ping には pong を返すだけ
    if (msg.type === 'ping') {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    switch (msg.type) {

      case 'join': {
        const roomId   = String(msg.roomId   || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
        const clientId = String(msg.clientId || '').replace(/[^a-z0-9]/g, '').slice(0, 16);
        const name     = String(msg.name     || '匿名').slice(0, 20);
        const lang     = String(msg.lang     || 'ja').replace(/[^a-zA-Z-]/g, '').slice(0, 10);

        if (!roomId || !clientId) return;

        if (currentRoomId && currentClientId) leaveRoom(currentRoomId, currentClientId);

        currentRoomId  = roomId;
        currentClientId = clientId;

        const room = getOrCreateRoom(roomId);
        room.set(clientId, { ws, name, lang });

        const participants = [...room.entries()]
          .filter(([id]) => id !== clientId)
          .map(([id, c]) => ({ id, name: c.name, lang: c.lang }));

        ws.send(JSON.stringify({ type: 'room_state', participants }));
        broadcast(room, { type: 'join', clientId, name, lang }, clientId);
        console.log(`[join]  room=${roomId} client=${clientId} name=${name} members=${room.size}`);
        break;
      }

      case 'speech': {
        if (!currentRoomId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const text = String(msg.text || '').slice(0, 500);
        if (!text) return;
        broadcast(room, {
          type: 'speech',
          clientId: currentClientId,
          name: room.get(currentClientId)?.name || '?',
          lang: room.get(currentClientId)?.lang || 'ja',
          text,
        }, currentClientId);
        break;
      }

      case 'speaking': {
        if (!currentRoomId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;
        broadcast(room, {
          type: 'speaking',
          clientId: currentClientId,
          active: !!msg.active,
        }, currentClientId);
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    clearInterval(aliveCheck);
    if (currentRoomId && currentClientId) leaveRoom(currentRoomId, currentClientId);
  });

  ws.on('error', (err) => {
    console.error(`[ws error] ${err.message}`);
    clearInterval(aliveCheck);
    try { ws.terminate(); } catch {}
  });
});

function leaveRoom(roomId, clientId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.has(clientId)) return;
  room.delete(clientId);
  console.log(`[leave] room=${roomId} client=${clientId} remaining=${room.size}`);
  broadcast(room, { type: 'leave', clientId });
  cleanRoom(roomId);
}

// ── 起動 ──────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`BABEL server listening on port ${PORT}`);
});
