/**
 * BABEL WebSocket + 静的ファイルサーバー
 * - サーバー側でGemini APIを使って翻訳（クライアントへのAPIキー露出なし）
 * - 同一ルーム内の受信言語ごとに1回だけ翻訳してキャッシュ → APIコール最小化
 *
 * 環境変数:
 *   GEMINI_API_KEY  ... Google AI StudioのAPIキー（Renderの環境変数に設定）
 *   PORT            ... リッスンポート（Renderが自動設定）
 */

const { WebSocketServer, WebSocket } = require('ws');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PORT           = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_URL     =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// メッセージサイズ上限 (8KiB)
const MAX_MSG_BYTES = 8192;

// ── HTTP ──────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      connections: totalConnections(),
      uptime: Math.floor(process.uptime()),
      gemini: !!GEMINI_API_KEY,
    }));
    return;
  }

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

// ── WebSocket ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

/**
 * rooms: Map<roomId, Map<clientId, {
 *   ws, name, lang (話す言語), receiveLang (受信言語)
 * }>>
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

/** excludeId を除く全クライアントに同じJSONを送る */
function broadcast(room, data, excludeId = null) {
  const json = JSON.stringify(data);
  for (const [id, client] of room) {
    if (id === excludeId) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(json);
    }
  }
}

// ── Gemini 翻訳 ────────────────────────────────────────────────
const LANG_NAMES = {
  ja: '日本語', en: 'English', zh: '中文', ko: '한국어',
  vi: 'Tiếng Việt', th: 'ภาษาไทย', pt: 'Português',
  es: 'Español', fr: 'Français', de: 'Deutsch',
};

/**
 * Gemini APIを使ってテキストを翻訳する
 * @param {string} text     原文
 * @param {string} fromLang 言語コード (例: 'ja')
 * @param {string} toLang   言語コード (例: 'en')
 * @returns {Promise<string>} 翻訳結果（失敗時は原文）
 */
async function translateWithGemini(text, fromLang, toLang) {
  if (!GEMINI_API_KEY) {
    console.warn('[gemini] API key not set — returning original text');
    return text;
  }
  if (fromLang === toLang) return text;

  const toLangName   = LANG_NAMES[toLang]   || toLang;
  const fromLangName = LANG_NAMES[fromLang] || fromLang;

  const prompt =
    `Translate the following text from ${fromLangName} to ${toLangName}.\n` +
    `Output ONLY the translated text with no explanation, no quotes, and no extra punctuation.\n\n` +
    `Text: ${text}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[gemini] request timed out');
      resolve(text);
    }, 8000);

    const req = https.request(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(raw);
          const translated = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          resolve(translated || text);
        } catch {
          console.error('[gemini] parse error:', raw.slice(0, 200));
          resolve(text);
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[gemini] request error:', err.message);
      resolve(text);
    });

    req.write(body);
    req.end();
  });
}

/**
 * speech受信時のメイン処理
 * - ルーム内の受信言語セットを収集
 * - 言語ごとに1回だけGeminiで翻訳（同一言語はキャッシュ再利用）
 * - 各クライアントに自分用の翻訳済みspeechを個別送信
 */
async function handleSpeech(room, senderId, text) {
  const sender = room.get(senderId);
  if (!sender) return;

  const senderLang = sender.lang; // 話す言語

  // 受信者ごとに必要な翻訳言語を収集（送信者自身を除く）
  const targetLangs = new Set();
  for (const [id, client] of room) {
    if (id === senderId) continue;
    targetLangs.add(client.receiveLang || client.lang);
  }

  // 言語ごとに1回だけ翻訳してキャッシュ
  const cache = {}; // { [toLang]: translatedText }
  await Promise.all([...targetLangs].map(async (toLang) => {
    cache[toLang] = await translateWithGemini(text, senderLang, toLang);
  }));

  // 各クライアントに個別送信
  for (const [id, client] of room) {
    if (id === senderId) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    const receiveLang = client.receiveLang || client.lang;
    const translated  = cache[receiveLang] ?? text;

    client.ws.send(JSON.stringify({
      type: 'speech',
      clientId: senderId,
      name:     sender.name,
      lang:     senderLang,
      original: text,
      translated,
    }));
  }
}

// ── 接続処理 ───────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let currentRoomId   = null;
  let currentClientId = null;

  let lastSeen = Date.now();
  const aliveCheck = setInterval(() => {
    if (Date.now() - lastSeen > 60000) {
      console.log(`[timeout] client=${currentClientId} — terminating`);
      clearInterval(aliveCheck);
      ws.terminate();
    }
  }, 30000);

  ws.on('message', (raw) => {
    // 巨大メッセージ対策
    if (raw.length > MAX_MSG_BYTES) {
      console.warn(`[oversized] client=${currentClientId} sent ${raw.length} bytes`);
      clearInterval(aliveCheck);
      ws.terminate();
      return;
    }

    lastSeen = Date.now();

    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ping') {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    switch (msg.type) {

      case 'join': {
        const roomId     = String(msg.roomId      || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
        const clientId   = String(msg.clientId    || '').replace(/[^a-z0-9]/g, '').slice(0, 16);
        const name       = String(msg.name        || '匿名').slice(0, 20);
        const lang       = String(msg.lang        || 'ja').replace(/[^a-zA-Z-]/g, '').slice(0, 10);
        // ← 追加: receiveLang（受信言語）
        const receiveLang = String(msg.receiveLang || lang).replace(/[^a-zA-Z-]/g, '').slice(0, 10);

        if (!roomId || !clientId) return;
        if (currentRoomId && currentClientId) leaveRoom(currentRoomId, currentClientId);

        currentRoomId   = roomId;
        currentClientId = clientId;

        const room = getOrCreateRoom(roomId);
        room.set(clientId, { ws, name, lang, receiveLang });

        const participants = [...room.entries()]
          .filter(([id]) => id !== clientId)
          .map(([id, c]) => ({ id, name: c.name, lang: c.lang }));

        ws.send(JSON.stringify({ type: 'room_state', participants }));
        broadcast(room, { type: 'join', clientId, name, lang }, clientId);
        console.log(`[join]  room=${roomId} client=${clientId} name=${name} lang=${lang} recv=${receiveLang} members=${room.size}`);
        break;
      }

      case 'leave': {
        if (currentRoomId && currentClientId) {
          leaveRoom(currentRoomId, currentClientId);
          currentRoomId   = null;
          currentClientId = null;
        }
        break;
      }

      case 'speech': {
        if (!currentRoomId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const text = String(msg.text || '').slice(0, 500);
        if (!text) return;

        // 非同期で翻訳 & 個別配信
        handleSpeech(room, currentClientId, text).catch(err => {
          console.error('[handleSpeech]', err);
        });
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
  if (!room || !room.has(clientId)) return;
  room.delete(clientId);
  console.log(`[leave] room=${roomId} client=${clientId} remaining=${room.size}`);
  broadcast(room, { type: 'leave', clientId });
  cleanRoom(roomId);
}

// ── 起動 ───────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`BABEL server listening on port ${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY が未設定です。翻訳はスキップされ原文が返ります。');
  }
});
