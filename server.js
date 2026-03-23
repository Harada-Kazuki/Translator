/**
 * Kw-Translator WebSocket + 静的ファイルサーバー
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

const PORT             = process.env.PORT || 3000;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY || '';
const MODEL_NAME       = 'gemini-2.0-flash-lite';
const GEMINI_URL       = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
const SUPABASE_URL     = process.env.SUPABASE_URL || '';
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY || '';

const MAX_MSG_BYTES = 8192;

// ── Supabase ログ保存 ─────────────────────────────────────────
async function saveLog({ roomId, speaker, lang, original, translated }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const url  = `${SUPABASE_URL}/rest/v1/logs`;
  const body = JSON.stringify({ room_id: roomId, speaker, lang, original, translated });
  const req  = https.request(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=minimal',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => {
    if (res.statusCode >= 300) {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => console.error('[supabase] save error:', res.statusCode, raw.slice(0, 200)));
    }
  });
  req.on('error', e => console.error('[supabase] request error:', e.message));
  req.write(body);
  req.end();
}

// ── Supabase ログ取得 ────────────────────────────────────────
async function fetchLogs(roomId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const query = roomId
    ? `room_id=eq.${encodeURIComponent(roomId)}&order=created_at.asc&limit=500`
    : `order=created_at.desc&limit=500`;
  const url = `${SUPABASE_URL}/rest/v1/logs?${query}`;
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept':        'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { console.error('[supabase] parse error:', raw.slice(0, 200)); resolve([]); }
      });
    });
    req.on('error', e => { console.error('[supabase] fetch error:', e.message); resolve([]); });
    req.end();
  });
}

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
      supabase: !!(SUPABASE_URL && SUPABASE_KEY),
    }));
    return;
  }

  if (req.url.startsWith('/logs')) {
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const roomId = qs.get('room') || '';
    fetchLogs(roomId).then(logs => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(logs));
    }).catch(() => {
      res.writeHead(500); res.end('[]');
    });
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

// ── 翻訳が必要か判定 ──────────────────────────────────────────
// 'zh' と 'zh-TW' は別言語として扱う（簡体字 vs 繁体字）
// それ以外は先頭タグ（'-' 前）が一致していれば同一言語とみなす
function isSameLang(a, b) {
  if (a === b) return true;
  // zh系は完全一致のみ同一扱い
  if (a.startsWith('zh') || b.startsWith('zh')) return false;
  // その他は基底タグで比較（例: en-US と en-GB は同一）
  return a.split('-')[0] === b.split('-')[0];
}

// ── Gemini 翻訳 ────────────────────────────────────────────────
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

  // 同言語はスキップ（修正済み：zh/zh-TW を正しく区別）
  if (isSameLang(fromLang, toLang)) return text;

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

// ── 翻訳キャッシュ（直近200件） ────────────────────────────────
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
 * speech 受信時のメイン処理
 *
 * 最適化ポイント：
 * 1. 同言語の受信者には翻訳せずそのまま送信（APIコール節約）
 * 2. 同じ翻訳先言語は1回だけAPIを叩いてキャッシュ
 * 3. 短すぎるテキスト（2文字以下）はスキップ
 */
async function handleSpeech(room, senderId, text, currentRoomId) {
  const sender = room.get(senderId);
  if (!sender) return;

  if ([...text].length <= 2) {
    console.log(`[speech] too short, skip: "${text}"`);
    return;
  }

  const fromLang = sender.lang;
  console.log(`[speech] from=${sender.name}(${fromLang}) text="${text}" roomSize=${room.size}`);

  // 受信者の言語セットを収集（同言語は翻訳不要なのでAPIを叩かない）
  const targetLangs = new Set();
  for (const [id, client] of room) {
    if (id === senderId) continue;
    if (!isSameLang(fromLang, client.lang)) {
      targetLangs.add(client.lang);
    }
  }

  // 翻訳が必要な言語のみAPIを叩く（キャッシュヒットは除外）
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

  // 各クライアントに送信
  const savedLangs = new Set();
  for (const [id, client] of room) {
    if (id === senderId) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // 同言語なら原文そのまま（翻訳なし）
    const translated = isSameLang(fromLang, client.lang)
      ? text
      : (cache[client.lang] ?? text);

    client.ws.send(JSON.stringify({
      type:       'speech',
      clientId:   senderId,
      name:       sender.name,
      lang:       fromLang,
      original:   text,
      translated,
    }));

    // 同翻訳先言語は1レコードのみ保存
    if (!savedLangs.has(client.lang)) {
      savedLangs.add(client.lang);
      saveLog({
        roomId:     currentRoomId,
        speaker:    sender.name,
        lang:       fromLang,
        original:   text,
        translated,
      }).catch(e => console.error('[supabase] saveLog error:', e));
    }
  }

  // 送信者自身のログ（原文）
  saveLog({
    roomId:     currentRoomId,
    speaker:    sender.name,
    lang:       fromLang,
    original:   text,
    translated: text,
  }).catch(e => console.error('[supabase] saveLog error:', e));
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

        handleSpeech(room, currentClientId, text, currentRoomId).catch(err => {
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
