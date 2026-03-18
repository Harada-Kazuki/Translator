/**
 * BABEL WebSocket Server
 * Render の無料プランで動作する軽量シグナリングサーバー
 *
 * 役割:
 *   - ルーム管理 (join / leave / presence)
 *   - speech メッセージのルーム内ブロードキャスト
 *   - 翻訳は各クライアントが行う（サーバーは中継のみ）
 *
 * Render 無料プランの制約:
 *   - 15分アイドルでスリープ → 最初の接続に数秒かかる場合あり
 *   - メモリ 512MB / CPU 共有
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// ── HTTP サーバー (Render のヘルスチェック用) ──────────────────
const httpServer = http.createServer((req, res) => {
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
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BABEL WS Server running');
});

// ── WebSocket サーバー ─────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

/**
 * rooms: Map<roomId, Map<clientId, { ws, name, lang }>>
 */
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

/**
 * ルーム内の全員（または送信者を除く全員）にメッセージを送る
 */
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

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // 不正なJSONは無視
    }

    // 最低限のバリデーション
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {

      case 'join': {
        // サニタイズ
        const roomId = String(msg.roomId || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
        const clientId = String(msg.clientId || '').replace(/[^a-z0-9]/g, '').slice(0, 16);
        const name = String(msg.name || '匿名').slice(0, 20);
        const lang = String(msg.lang || 'ja').replace(/[^a-zA-Z-]/g, '').slice(0, 10);

        if (!roomId || !clientId) return;

        // 既存ルームからの退室処理（タブリロード等）
        if (currentRoomId && currentClientId) {
          leaveRoom(currentRoomId, currentClientId);
        }

        currentRoomId = roomId;
        currentClientId = clientId;

        const room = getOrCreateRoom(roomId);
        room.set(clientId, { ws, name, lang });

        // 入室者に現在の参加者リストを送信
        const participants = [...room.entries()]
          .filter(([id]) => id !== clientId)
          .map(([id, c]) => ({ id, name: c.name, lang: c.lang }));

        ws.send(JSON.stringify({ type: 'room_state', participants }));

        // 他の参加者に join を通知
        broadcast(room, { type: 'join', clientId, name, lang }, clientId);

        console.log(`[join] room=${roomId} id=${clientId} name=${name} lang=${lang} members=${room.size}`);
        break;
      }

      case 'speech': {
        if (!currentRoomId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;

        // テキストの長さ制限
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

      default:
        // 未知のメッセージタイプは無視
        break;
    }
  });

  ws.on('close', () => {
    if (currentRoomId && currentClientId) {
      leaveRoom(currentRoomId, currentClientId);
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws error] ${err.message}`);
    try { ws.terminate(); } catch {}
  });
});

function leaveRoom(roomId, clientId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const client = room.get(clientId);
  if (!client) return;

  room.delete(clientId);
  console.log(`[leave] room=${roomId} id=${clientId} remaining=${room.size}`);

  broadcast(room, { type: 'leave', clientId });
  cleanRoom(roomId);
}

// ── 起動 ──────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`BABEL server listening on port ${PORT}`);
});
