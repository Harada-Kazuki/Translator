/**
 * Kw-Translator WebSocket + 静的ファイルサーバー
 * - 母語1つを設定するだけで全言語間の翻訳に対応
 * - 受信者ごとに必要な言語だけAPIを叩いてキャッシュ
 *
 * 環境変数:
 *   GEMINI_API_KEY  ... Google AI StudioのAPIキー
 *   PORT            ... リッスンポート（Renderが自動設定）
 */

const { WebSocketServer, WebSocket } = require('ws');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PORT           = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL_NAME     = 'gemini-3.1-flash-lite-preview';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

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
 *   ws, name, lang (母語コード e.g. 'ja')
 * }>>
 *
 * 母語1つだけ管理。
 * 話す言語 = 母語、受け取りたい言語 = 母語 → サーバーが自動変換
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
// 30言語対応
const LANG_NAMES = {
  ja:  '日本語',
  en:  'English',
  zh:  'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  ko:  'Korean',
  vi:  'Vietnamese',
  th:  'Thai',
  id:  'Indonesian',
  ms:  'Malay',
  tl:  'Filipino (Tagalog)',
  hi:  'Hindi',
  bn:  'Bengali',
  ur:  'Urdu',
  ar:  'Arabic',
  fa:  'Persian (Farsi)',
  tr:  'Turkish',
  ru:  'Russian',
  uk:  'Ukrainian',
  pl:  'Polish',
  nl:  'Dutch',
  de:  'German',
  fr:  'French',
  es:  'Spanish',
  pt:  'Portuguese',
  it:  'Italian',
  ro:  'Romanian',
  sv:  'Swedish',
  no:  'Norwegian',
  da:  'Danish',
  fi:  'Finnish',
};

async function translateWithGemini(text, fromLang, toLang) {
  if (!GEMINI_API_KEY) {
    console.warn('[gemini] API key not set — returning original text');
    return text;
  }

  // 同言語はそのまま返す
  const fromBase = fromLang.split('-')[0];
  const toBase   = toLang.split('-')[0];
  if (fromBase === toBase && fromLang !== 'zh') return text;
  // zh と zh-TW は別扱い
  if (fromLang === toLang) return text;

  const fromName = LANG_NAMES[fromLang] || fromLang;
  const toName   = LANG_NAMES[toLang]   || toLang;

  const prompt =
    `Translate the following text from ${fromName} to ${toName}.\n` +
    `Output ONLY the translated text. No explanations, no quotes, no extra punctuation.\n\n` +
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
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const json = JSON.parse(raw);
          const translated = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (translated) {
            console.log(`[gemini] ${fromLang}→${toLang}: "${text}" => "${translated}"`);
            resolve(translated);
          } else {
            console.warn('[gemini] empty response:', raw.slice(0, 200));
            resolve(text);
          }
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
 * 翻訳結果キャッシュ（重複API呼び出し防止）
 * 直近200件を保持。同じ文章は何度話してもAPIを1回しか叩かない
 */
const translationCache = new Map();
const CACHE_MAX = 200;

function cacheGet(text, fromLang, toLang) {
  return translationCache.get(`${fromLang}:${toLang}:${text}`);
}
function cacheSet(text, fromLang, toLang, value) {
  if (translationCache.size >= CACHE_MAX) {
    translationCache.delete(translationCache.keys().next().value);
  }
  translationCache.set(`${fromLang}:${toLang}:${text}`, value);
}

/**
 * speech受信時のメイン処理
 * - 送信者の母語 → 各受信者の母語 に翻訳
 * - 同じ翻訳先言語はキャッシュして1回だけAPIを叩く
 * - 短すぎるテキスト（2文字以下）はスキップ
 */
async function handleSpeech(room, senderId, text) {
  const sender = room.get(senderId);
  if (!sender) return;

  // 相槌など短すぎるものはスキップ
  if ([...text].length <= 2) {
    console.log(`[speech] too short, skip: "${text}"`);
    return;
  }

  const fromLang = sender.lang;
  console.log(`[speech] from=${sender.name}(${fromLang}) text="${text}" roomSize=${room.size}`);

  // 送信者以外の受信言語を収集
  const targetLangs = new Set();
  for (const [id, client] of room) {
    if (id === senderId) continue;
    targetLangs.add(client.lang);
  }

  if (targetLangs.size === 0) {
    console.log('[speech] No other participants — skipping');
    return;
  }

  // 言語ごとに翻訳（キャッシュがあればAPIをスキップ）
  const cache = {};
  await Promise.all([...targetLangs].map(async (toLang) => {
    const hit = cacheGet(text, fromLang, toLang);
    if (hit !== undefined) {
      console.log(`[cache] hit ${fromLang}→${toLang}: "${text}"`);
      cache[toLang] = hit;
      return;
    }
    const translated = await translateWithGemini(text, fromLang, toLang);
    cacheSet(text, fromLang, toLang, translated);
    cache[toLang] = translated;
  }));

  // 各クライアントに個別送信
  for (const [id, client] of room) {
    if (id === senderId) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    const translated = cache[client.lang] ?? text;

    client.ws.send(JSON.stringify({
      type:       'speech',
      clientId:   senderId,
      name:       sender.name,
      lang:       fromLang,
      original:   text,
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
      console.log(`[timeout] client=${currentClientId}`);
      clearInterval(aliveCheck);
      ws.terminate();
    }
  }, 30000);

  ws.on('message', (raw) => {
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
        const roomId   = String(msg.roomId   || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
        const clientId = String(msg.clientId || '').replace(/[^a-z0-9]/g, '').slice(0, 16);
        const name     = String(msg.name     || '匿名').slice(0, 20);
        // 母語コードのみ（'ja', 'en', 'zh-TW' など）
        const lang     = String(msg.lang     || 'ja').replace(/[^a-zA-Z-]/g, '').slice(0, 10);

        if (!roomId || !clientId) return;
        if (currentRoomId && currentClientId) leaveRoom(currentRoomId, currentClientId);

        currentRoomId   = roomId;
        currentClientId = clientId;

        const room = getOrCreateRoom(roomId);
        room.set(clientId, { ws, name, lang });

        const participants = [...room.entries()]
          .filter(([id]) => id !== clientId)
          .map(([id, c]) => ({ id, name: c.name, lang: c.lang }));

        ws.send(JSON.stringify({ type: 'room_state', participants }));
        broadcast(room, { type: 'join', clientId, name, lang }, clientId);
        console.log(`[join]  room=${roomId} client=${clientId} name=${name} lang=${lang} members=${room.size}`);
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
          type:     'speaking',
          clientId: currentClientId,
          active:   !!msg.active,
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
  console.log(`Kw-Translator server listening on port ${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY が未設定です。翻訳はスキップされ原文が返ります。');
  } else {
    console.log(`✅  Gemini API ready (${Object.keys(LANG_NAMES).length} languages)`);
  }
});
