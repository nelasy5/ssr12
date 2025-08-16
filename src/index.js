// src/index.js
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import Redis from 'ioredis';
import dns from 'node:dns/promises';

// ====== ENV ======
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || ''; // можно пустым для тестов
const HTTPS_RPC = process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta');
const WSS_RPC   = process.env.SOLANA_WSS_URL   || 'wss://api.mainnet-beta.solana.com';
const EXPLORER  = (process.env.EXPLORER || 'solscan').toLowerCase(); // solscan | solanafm | xray
const SEED_ADDRS = (process.env.MONITOR_ADDRESSES || '').split(',').map(s=>s.trim()).filter(Boolean);
const ADMIN_CHAT_IDS = (process.env.ALLOWED_USER_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!CHANNEL_ID) {
  console.warn('[warn] TELEGRAM_CHANNEL_ID не задан — в канал слать не будем, но команды доступны.');
}

// ====== TELEGRAM (polling) ======
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    const me = await bot.getMe();
    console.log('[tg] bot online as @' + me.username);
  } catch (e) { console.error('[tg] init error:', e?.message || e); }
})();
bot.on('polling_error', (err) => console.error('[tg] polling_error:', err?.response?.body || err.message || err));
bot.on('webhook_error',  (err) => console.error('[tg] webhook_error:', err?.message || err));
bot.onText(/^\/start$/, (m) => bot.sendMessage(m.chat.id, 'Я на связи. Команды: /status, /list, /add, /remove, /redis'));
bot.onText(/^\/ping$/,  (m) => bot.sendMessage(m.chat.id, 'pong'));
bot.on('message', (m) => console.log('[tg] incoming', m.chat.id, m.text));

/* ======================================================================
   REDIS (совместимо с твоим "рабочим" проектом + fallback на Public)
   Поддерживает переменные:
   - REDISHOST / REDISPORT / REDISUSER / REDISPASSWORD
   - REDIS_URL (private)
   - REDIS_PUBLIC_URL (public, proxy)
   ====================================================================== */


import dns from 'node:dns/promises';

function urlFromParts() {
  const host = process.env.REDISHOST || process.env.REDIS_HOST;
  const port = process.env.REDISPORT || process.env.REDIS_PORT || '6379';
  const user = process.env.REDISUSER || process.env.REDIS_USER || 'default';
  const pass = process.env.REDISPASSWORD || process.env.REDIS_PASSWORD;
  if (!host || !pass) return null;
  // важное: оставляем явный "redis://" (без TLS) — как в рабочем проекте
  return `redis://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

function buildClient(url) {
  const useTLS = url.startsWith('rediss://');
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    reconnectOnError: () => true,
    tls: useTLS ? {} : undefined,
  });
}

async function tryConnect(url, label) {
  const client = buildClient(url);
  client.on('error', (e) => console.error(`[redis:${label}]`, e?.message || e));
  try {
    // быстрый DNS-чек (не критично, просто ускоряет провал)
    try {
      const host = new URL(url).hostname;
      await dns.lookup(host);
    } catch (_) {}
    await client.connect();
    const pong = await client.ping();
    console.log(`[redis:${label}] connected, ping=${pong}`);
    return client;
  } catch (e) {
    try { client.disconnect(); } catch {}
    throw e;
  }
}

async function makeRedis() {
  // 1) Пытаемся собрать private URL из раздельных переменных,
  //    чтобы форсировать host = redis.railway.internal (как в рабочем проекте)
  let privateUrl = urlFromParts();

  // 2) Если раздельных нет — используем REDIS_URL как есть
  if (!privateUrl && process.env.REDIS_URL) privateUrl = process.env.REDIS_URL;

  const publicUrl = process.env.REDIS_PUBLIC_URL; // можно оставить пустым, если приватка ок

  if (privateUrl) {
    const host = new URL(privateUrl).hostname;
    console.log('[redis] try PRIVATE:', host);
    try {
      const c = await tryConnect(privateUrl, 'private');
      console.log('[redis] using PRIVATE URL:', host);
      return c;
    } catch (e) {
      console.warn('[redis] private connect failed:', e?.message || e);
      if (!publicUrl) {
        console.warn('[redis] public URL not set — Redis будет отключён');
        return null;
      }
      console.log('[redis] fallback to PUBLIC…');
      return await tryConnect(publicUrl, 'public');
    }
  }

  if (publicUrl) {
    console.log('[redis] no private URL, using PUBLIC…');
    return await tryConnect(publicUrl, 'public');
  }

  console.warn('[redis] нет REDIS_URL/REDISHOST/REDIS_PUBLIC_URL — персистентность отключена');
  return null;
}

const redis = await makeRedis();

if (redis) {
  redis.on('ready', () => console.log('[redis] ready'));
  redis.on('end', () => console.warn('[redis] disconnected'));
}

// /redis — показать реальное подключение (оставь как у тебя)
bot.onText(/^\/redis$/, async (msg) => {
  if (!redis) return bot.sendMessage(msg.chat.id, 'Redis: отключён (нет конфигурации).');
  try {
    const opts = redis.options || {};
    const host = opts.host || opts.connectionOptions?.host;
    const port = opts.port || opts.connectionOptions?.port;
    const isTLS = !!(opts.tls || opts.connectionOptions?.tls);
    const pong = await redis.ping();
    await bot.sendMessage(
      msg.chat.id,
      `Redis OK: ${pong}\nHost: ${host}:${port}\nTLS: ${isTLS ? 'on' : 'off'}`
    );
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Redis error: ${e?.message || e}`);
  }
});

// ====== SOLANA CONNECTION ======
const connection = new Connection(HTTPS_RPC, { wsEndpoint: WSS_RPC, commitment: 'confirmed' });

// ====== Helpers ======
const WATCH_SET_KEY    = 'watch:addresses';
const WATCH_LABELS_KEY = 'watch:labels'; // HSET: address -> label

const seenSignatures = new Set();
const SEEN_MAX = 5000;

function rememberSig(sig) {
  seenSignatures.add(sig);
  if (seenSignatures.size > SEEN_MAX) {
    for (const s of seenSignatures) { seenSignatures.delete(s); break; }
  }
}

function txLink(signature) {
  switch (EXPLORER) {
    case 'solanafm': return `https://solana.fm/tx/${signature}?cluster=mainnet-solanafmbeta`;
    case 'xray':     return `https://xray.helius.xyz/tx/${signature}`;
    default:         return `https://solscan.io/tx/${signature}`;
  }
}
function addrLink(address) {
  switch (EXPLORER) {
    case 'solanafm': return `https://solana.fm/address/${address}?cluster=mainnet-solanafmbeta`;
    case 'xray':     return `https://xray.helius.xyz/address/${address}`;
    default:         return `https://solscan.io/account/${address}`;
  }
}
function lamportsToSOL(l) { return l / 1_000_000_000; }
function isValidPubkey(a) { try { new PublicKey(a); return true; } catch { return false; } }
function shortAddr(a) { return `${a.slice(0,4)}…${a.slice(-4)}`; }
function fmtUSD(v) { return `~ $${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }

// labels (названия)
const labelsMem = new Map();
async function setLabel(address, label) {
  if (!label) return;
  if (redis) { try { await redis.hset(WATCH_LABELS_KEY, address, label); } catch {} }
  else labelsMem.set(address, label);
}
async function getLabel(address) {
  if (redis) { try { return await redis.hget(WATCH_LABELS_KEY, address); } catch { return null; } }
  return labelsMem.get(address) || null;
}
async function delLabel(address) {
  if (redis) { try { await redis.hdel(WATCH_LABELS_KEY, address); } catch {} }
  else labelsMem.delete(address);
}

// SOL price (USD) с кэшем 60 сек
let _priceCache = { usd: 0, ts: 0 };
async function getSolPriceUSD() {
  const now = Date.now();
  if (now - _priceCache.ts < 60_000 && _priceCache.usd > 0) return _priceCache.usd;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const j = await r.json();
    const usd = Number(j?.solana?.usd) || 0;
    if (usd > 0) _priceCache = { usd, ts: now };
    return usd;
  } catch {
    return _priceCache.usd || 0;
  }
}

// ====== Redis-backed watch list ======
async function getWatchedAddresses() {
  if (!redis) return SEED_ADDRS;
  return await redis.smembers(WATCH_SET_KEY);
}
async function addWatchedAddresses(addrs) {
  if (!redis) return { added: addrs, skipped: [] };
  const added = [];
  for (const a of addrs) {
    const res = await redis.sadd(WATCH_SET_KEY, a);
    if (res === 1) added.push(a);
  }
  return { added, skipped: addrs.filter(a => !added.includes(a)) };
}
async function removeWatchedAddresses(addrs) {
  if (!redis) return { removed: addrs, skipped: [] };
  const removed = [];
  for (const a of addrs) {
    const res = await redis.srem(WATCH_SET_KEY, a);
    if (res === 1) removed.push(a);
  }
  return { removed, skipped: addrs.filter(a => !removed.includes(a)) };
}
async function ensureSeeded() {
  if (!redis || SEED_ADDRS.length === 0) return;
  const count = await redis.scard(WATCH_SET_KEY);
  if (count === 0) {
    await redis.sadd(WATCH_SET_KEY, ...SEED_ADDRS);
    console.log('[redis] seeded from MONITOR_ADDRESSES');
  }
}

// ====== SOL: rate-limit & queue ======
const SOL_RATE_MAX_PER_SEC = Number(process.env.SOL_RATE_MAX_PER_SEC || 6);
const SOL_RATE_CONCURRENCY = Number(process.env.SOL_RATE_CONCURRENCY || 2);

const solQueue = [];
const solInflight = new Set();
let solLastTick = 0;

function enqueueSolTx(signature, mentionPubkeys) {
  const exists =
    solQueue.find(i => i.signature === signature) ||
    [...solInflight].find(i => i.signature === signature);
  if (exists) {
    const set = new Set(exists.mentions.map(p => p.toBase58()));
    for (const p of mentionPubkeys) set.add(p.toBase58());
    exists.mentions = [...set].map(s => new PublicKey(s));
    return;
  }
  solQueue.push({ signature, mentions: mentionPubkeys, tries: 0, nextAt: 0 });
}

async function fetchAndNotifySol(item) {
  const { signature, mentions } = item;
  try {
    await handleSignature(signature, mentions);
  } catch (e) {
    const msg = String(e?.message || '');
    const is429 = msg.includes('429') || msg.includes('Too Many Requests');
    if (is429 && item.tries < 6) {
      item.tries++;
      const delay = Math.min(8000, 500 * 2 ** (item.tries - 1)); // 0.5s → 8s
      item.nextAt = Date.now() + delay + Math.floor(Math.random() * 200);
      solQueue.push(item);
      console.warn(`[sol] 429, retry #${item.tries} in ${delay}ms for ${signature}`);
      return;
    }
    throw e;
  }
}

function processSolQueue() {
  const now = Date.now();
  if (now - solLastTick < 250) return;
  solLastTick = now;

  const perTick = Math.max(1, Math.floor(SOL_RATE_MAX_PER_SEC / 4));
  let slots = Math.max(0, SOL_RATE_CONCURRENCY - solInflight.size);
  if (!slots) return;

  let launched = 0;
  for (let i = 0; i < solQueue.length && launched < Math.min(perTick, slots); i++) {
    const item = solQueue[i];
    if (item.nextAt > now) continue;

    solQueue.splice(i, 1); i--;
    solInflight.add(item);
    fetchAndNotifySol(item).finally(() => solInflight.delete(item));
    launched++;
  }
}
setInterval(processSolQueue, 60);

// ====== Subscriptions ======
const subscriptions = new Map(); // address -> subId
async function subscribeAddress(address) {
  if (subscriptions.has(address)) return;
  const pk = new PublicKey(address);

  // основной способ: фильтр по PublicKey
  try {
    const subId = connection.onLogs(
      pk,
      (logInfo) => {
        enqueueSolTx(logInfo.signature, [pk]);
      },
      'finalized'
    );
    subscriptions.set(address, subId);
    console.log(`[sol] subscribed (pk) ${address} (id=${subId})`);
    return;
  } catch (e) {
    console.warn(`[sol] onLogs(pk) failed for ${address}:`, e?.message || e);
  }

  // фолбэк: mentions
  try {
    const subId = connection.onLogs(
      { mentions: [pk.toBase58()] },
      (logInfo) => {
        enqueueSolTx(logInfo.signature, [pk]);
      },
      'finalized'
    );
    subscriptions.set(address, subId);
    console.log(`[sol] subscribed (mentions) ${address} (id=${subId})`);
  } catch (e) {
    console.error(`[sol] both onLogs methods failed for ${address}:`, e?.message || e);
  }
}

async function unsubscribeAddress(address) {
  const subId = subscriptions.get(address);
  if (subId != null) {
    try { await connection.removeOnLogsListener(subId); }
    catch (e) { console.warn('[sol] remove sub error:', e?.message || e); }
    subscriptions.delete(address);
    console.log(`[sol] unsubscribed ${address}`);
  }
}
async function bootstrap() {
  await ensureSeeded();
  const list = (await getWatchedAddresses()).filter(isValidPubkey);
  const base = (list.length ? list : SEED_ADDRS).filter(isValidPubkey);
  for (const a of base) await subscribeAddress(a);
}
bootstrap().catch(console.error);

// ====== TX handler ======
async function handleSignature(signature, mentionPubkeys) {
  if (seenSignatures.has(signature)) return;
  rememberSig(signature);

  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) return;
  const { meta, transaction } = tx;

  const pre = meta?.preBalances || [];
  const post = meta?.postBalances || [];
  const accounts = transaction.message.accountKeys.map(k => k.pubkey?.toBase58?.() || k.toBase58());

  // изменения по отслеживаемым адресам
  const deltas = [];
  for (const watched of mentionPubkeys) {
    const idx = accounts.findIndex(a => a === watched.toBase58());
    if (idx >= 0 && pre[idx] != null && post[idx] != null) {
      const delta = post[idx] - pre[idx];
      if (delta !== 0) deltas.push({ address: watched.toBase58(), deltaLamports: delta });
    }
  }

  const price = await getSolPriceUSD();
  const lines = [];
  lines.push('🟣 Новая транзакция в Solana');
  lines.push(`🔗 Подпись: <a href="${txLink(signature)}">${signature.slice(0,8)}…${signature.slice(-6)}</a>`);

  if (deltas.length) {
    lines.push('\n📈 Изменение баланса:');
    for (const d of deltas) {
      const plainLabel = (await getLabel(d.address)) || shortAddr(d.address);
      const labelLink = `<a href="${addrLink(d.address)}">${plainLabel}</a>`;
      const deltaSOL = lamportsToSOL(d.deltaLamports);
      const usdChange = price ? deltaSOL * price : 0;

      // текущий баланс после транзакции
      let balSOL = null, usdBal = null;
      try {
        const balLamports = await connection.getBalance(new PublicKey(d.address), 'finalized');
        balSOL = lamportsToSOL(balLamports);
        usdBal = price ? balSOL * price : null;
      } catch {}

      const sign = deltaSOL > 0 ? '+' : '';
      lines.push(`• ${labelLink}: ${sign}${deltaSOL.toFixed(6)} SOL ${price ? fmtUSD(usdChange) : ''}`);
      if (balSOL != null) {
        lines.push(`  Текущий баланс: ${balSOL.toFixed(6)} SOL ${usdBal != null ? fmtUSD(usdBal) : ''}`);
      }
    }
  } else {
    lines.push('\nℹ️ Адрес(а) упомянут(ы) в транзакции:');
    for (const m of mentionPubkeys) {
      const a = m.toBase58();
      const plainLabel = (await getLabel(a)) || shortAddr(a);
      const labelLink = `<a href="${addrLink(a)}">${plainLabel}</a>`;
      lines.push(`• ${labelLink} <code>(${shortAddr(a)})</code>`);
    }
  }

  if (CHANNEL_ID) {
    await bot.sendMessage(CHANNEL_ID, lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
  } else {
    console.log('[sol] message:', lines.join('\n'));
  }
}

// ====== Commands ======
function assertAdmin(msg) {
  if (ADMIN_CHAT_IDS.length === 0) return true;
  return ADMIN_CHAT_IDS.includes(String(msg.chat.id));
}

bot.onText(/^\/status$/, async (msg) => {
  const watched = await getWatchedAddresses();
  const lines = [];
  lines.push(`RPC (HTTPS): ${HTTPS_RPC}`);
  lines.push(`RPC (WSS): ${WSS_RPC}`);
  lines.push(`Канал: ${CHANNEL_ID || '(не задан)'}`);
  lines.push(`Отслеживаемые адреса (${watched.length}):`);
  for (const a of watched) {
    const label = await getLabel(a);
    lines.push(`• ${a} ${label ? `— ${label}` : ''} ${subscriptions.has(a) ? '✅' : '⚠️'}`);
  }
  if (ADMIN_CHAT_IDS.length) lines.push(`\nРазрешённые админы: ${ADMIN_CHAT_IDS.join(', ')}`);
  await bot.sendMessage(msg.chat.id, lines.join('\n'), { disable_web_page_preview: true });
});

bot.onText(/^\/list$/, async (msg) => {
  const watched = await getWatchedAddresses();
  if (!watched.length) return bot.sendMessage(msg.chat.id, 'Список пуст.');
  const rows = await Promise.all(watched.map(async a => {
    const label = await getLabel(a);
    return `• <code>${a}</code>${label ? ` — ${label}` : ''}`;
  }));
  await bot.sendMessage(msg.chat.id, `Сейчас отслеживаю:\n${rows.join('\n')}`, { parse_mode: 'HTML' });
});

// /redis — показать фактическое подключение
bot.onText(/^\/redis$/, async (msg) => {
  if (!redis) return bot.sendMessage(msg.chat.id, 'Redis: отключён (нет конфигурации).');
  try {
    const opts = redis.options || {};
    const host = opts.host || (opts.connectionOptions && opts.connectionOptions.host);
    const port = opts.port || (opts.connectionOptions && opts.connectionOptions.port);
    const isTLS = !!(opts.tls || (opts.connectionOptions && opts.connectionOptions.tls));
    const pong = await redis.ping();
    await bot.sendMessage(
      msg.chat.id,
      `Redis OK: ${pong}\nHost: ${host}:${port}\nTLS: ${isTLS ? 'on' : 'off'}`
    );
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Redis error: ${e?.message || e}`);
  }
});

// /add ADDRESS [LABEL]
bot.onText(/^\/add(?:\s+(.+))?$/i, async (msg, match) => {
  if (!assertAdmin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Нет прав на изменение списка.');
  const raw = (match[1] || '').trim();
  if (!raw) return bot.sendMessage(msg.chat.id, 'Использование: <code>/add ADDRESS [НАЗВАНИЕ]</code>', { parse_mode: 'HTML' });

  const [addr, ...rest] = raw.split(/\s+/);
  const label = rest.join(' ').trim();

  if (!isValidPubkey(addr)) return bot.sendMessage(msg.chat.id, '❌ Невалидный адрес.');

  let added = false;
  if (redis) added = (await redis.sadd(WATCH_SET_KEY, addr)) === 1;
  else added = !subscriptions.has(addr);

  if (added) await subscribeAddress(addr);
  if (label) await setLabel(addr, label);

  await bot.sendMessage(msg.chat.id, [
    added ? `✅ Добавлен и подписан: ${addr}` : `ℹ️ Уже в списке: ${addr}`,
    label ? `🏷 Название: ${label}` : null
  ].filter(Boolean).join('\n'));
});

// /remove ADDRESS
bot.onText(/^\/remove(?:\s+(.+))?$/i, async (msg, match) => {
  if (!assertAdmin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Нет прав на изменение списка.');
  const addr = (match[1] || '').trim();
  if (!addr) return bot.sendMessage(msg.chat.id, 'Использование: <code>/remove ADDRESS</code>', { parse_mode: 'HTML' });
  if (!isValidPubkey(addr)) return bot.sendMessage(msg.chat.id, '❌ Невалидный адрес.');

  let removed = false;
  if (redis) removed = (await redis.srem(WATCH_SET_KEY, addr)) === 1;
  else removed = subscriptions.has(addr);

  if (removed) {
    await unsubscribeAddress(addr);
    await delLabel(addr);
    await bot.sendMessage(msg.chat.id, `🗑 Удалён и отписан: ${addr}`);
  } else {
    await bot.sendMessage(msg.chat.id, `ℹ️ Адрес не найден в списке: ${addr}`);
  }
});

// ====== Heartbeat ======
setInterval(() => console.log(`[heartbeat] ${new Date().toISOString()}`), 60_000);
