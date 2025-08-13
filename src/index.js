// src/index.js
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import Redis from 'ioredis';
import dns from 'node:dns/promises';

// ====== ENV ======
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || ''; // можно пустым для теста команд
const HTTPS_RPC = process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta');
const WSS_RPC   = process.env.SOLANA_WSS_URL   || 'wss://api.mainnet-beta.solana.com';
const EXPLORER  = (process.env.EXPLORER || 'solscan').toLowerCase(); // solscan | solanafm | xray
const SEED_ADDRS = (process.env.MONITOR_ADDRESSES || '').split(',').map(s=>s.trim()).filter(Boolean);
const ADMIN_CHAT_IDS = (process.env.ALLOWED_USER_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!CHANNEL_ID) {
  console.warn('[warn] TELEGRAM_CHANNEL_ID не задан — уведомления о транзакциях в канал отправляться не будут, но команды доступны.');
}

// ====== TELEGRAM (polling) ======
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

(async () => {
  try {
    // гарантированно выключим вебхук, чтобы polling работал
    await bot.deleteWebHook({ drop_pending_updates: true });
    const me = await bot.getMe();
    console.log('[tg] bot online as @' + me.username);
  } catch (e) {
    console.error('[tg] init error:', e?.message || e);
  }
})();
bot.on('polling_error', (err) => console.error('[tg] polling_error:', err?.response?.body || err.message || err));
bot.on('webhook_error',  (err) => console.error('[tg] webhook_error:', err?.message || err));
bot.onText(/^\/start$/, (m) => bot.sendMessage(m.chat.id, 'Я на связи. Команды: /status, /list, /add, /remove, /redis'));
bot.onText(/^\/ping$/,  (m) => bot.sendMessage(m.chat.id, 'pong'));
bot.on('message', (m) => console.log('[tg] incoming', m.chat.id, m.text));

// ====== REDIS (авто TLS, private/public URL, нормальные логи) ======
function makeRedis() {
  const url = process.env.REDIS_URL;
  const optsCommon = {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    reconnectOnError: () => true
  };

  if (url) {
    const useTLS = url.startsWith('rediss://');
    return new Redis(url, { ...optsCommon, tls: useTLS ? {} : undefined });
  }

  // фолбэк: раздельные переменные
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT || 6379);
  const password = process.env.REDIS_PASSWORD || undefined;
  const useTLS = process.env.REDIS_TLS === '1';
  if (!host) {
    console.warn('[redis] REDIS_URL/REDIS_HOST не заданы — персистентность отключена.');
    return null;
  }
  return new Redis({ host, port, password, tls: useTLS ? {} : undefined, ...optsCommon });
}
const redis = makeRedis();
if (redis) {
  redis.on('error', (e) => console.error('[redis] error:', e?.message || e));
  redis.on('connect', () => console.log('[redis] connected'));
  redis.on('ready', () => console.log('[redis] ready'));
  redis.on('end', () => console.warn('[redis] disconnected'));
  redis.connect().catch((e) => console.error('[redis] connect failed:', e?.message || e));
}

// ====== SOLANA CONNECTION ======
const connection = new Connection(HTTPS_RPC, { wsEndpoint: WSS_RPC, commitment: 'confirmed' });

// ====== Helpers ======
const WATCH_SET_KEY = 'watch:addresses';
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
function lamportsToSOL(l) { return (l / 1_000_000_000).toFixed(6); }
function isValidPubkey(a) { try { new PublicKey(a); return true; } catch { return false; } }

// ====== Redis-backed watch list ======
async function getWatchedAddresses() {
  if (!redis) return SEED_ADDRS;
  return await redis.smembers(WATCH_SET_KEY);
}
async function addWatchedAddresses(addrs) {
  if (!redis) return { added: addrs, skipped: [] }; // неперсистентно, но подпишем
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

// ====== Subscriptions ======
const subscriptions = new Map(); // address -> subId
async function subscribeAddress(address) {
  if (subscriptions.has(address)) return;
  const pk = new PublicKey(address);

  // 1) Основной способ: фильтр по PublicKey
  try {
    const subId = connection.onLogs(
      pk,
      (logInfo) => {
        enqueueTx(logInfo.signature, [pk]);
      },
      'finalized'
    );
    subscriptions.set(address, subId);
    console.log(`[sol] subscribed (pk) ${address} (id=${subId})`);
    return;
  } catch (e) {
    console.warn(`[sol] onLogs(pk) failed for ${address}:`, e?.message || e);
  }

  // 2) Фолбэк: mentions (может не поддерживаться некоторыми RPC)
  try {
    const subId = connection.onLogs(
      { mentions: [pk.toBase58()] },
      (logInfo) => {
        enqueueTx(logInfo.signature, [pk]);
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

// === Rate limit & queue ===
// === Rate limit & queue ===
const RATE_MAX_PER_SEC = Number(process.env.SOL_RATE_MAX_PER_SEC || 6); // детальных запросов/сек
const RATE_CONCURRENCY = Number(process.env.SOL_RATE_CONCURRENCY || 2); // параллельных запросов

const _q = [];
const _inflight = new Set();
let _lastTick = 0;

function enqueueTx(signature, mentionPubkeys) {
  // если уже в работе — дополним mentions
  const exists = _q.find(i => i.signature === signature) || [..._inflight].find(i => i.signature === signature);
  if (exists) {
    const set = new Set(exists.mentions.map(p => p.toBase58()));
    for (const p of mentionPubkeys) set.add(p.toBase58());
    exists.mentions = [...set].map(s => new PublicKey(s));
    return;
  }
  _q.push({ signature, mentions: mentionPubkeys, tries: 0, nextAt: 0 });
}

async function fetchAndNotify(item) {
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
      _q.push(item);
      console.warn(`[sol] 429, retry #${item.tries} in ${delay}ms for ${signature}`);
      return;
    }
    throw e;
  }
}

function processQueue() {
  const now = Date.now();
  if (now - _lastTick < 250) return; // ~4 тика/сек
  _lastTick = now;

  const perTick = Math.max(1, Math.floor(RATE_MAX_PER_SEC / 4));
  let slots = Math.max(0, RATE_CONCURRENCY - _inflight.size);
  if (!slots) return;

  let launched = 0;
  for (let i = 0; i < _q.length && launched < Math.min(perTick, slots); i++) {
    const item = _q[i];
    if (item.nextAt > now) continue;

    _q.splice(i, 1); i--;
    _inflight.add(item);
    fetchAndNotify(item).finally(() => _inflight.delete(item));
    launched++;
  }
}
setInterval(processQueue, 60);
 // частый таймер, но работа по 250мс-шагам

async function fetchAndNotify(item) {
  const { signature, mentions } = item;
  try {
    await handleSignature(signature, mentions);
  } catch (e) {
    // если 429 — бэк‑офф и обратно в очередь
    const msg = String(e?.message || '');
    const is429 = msg.includes('429') || msg.includes('Too Many Requests');
    if (is429 && item.tries < 6) {
      item.tries++;
      const delay = Math.min(8000, 500 * 2 ** (item.tries - 1)); // 0.5s → 8s
      item.nextAt = Date.now() + delay + Math.floor(Math.random() * 200); // джиттер
      _q.push(item);
      console.warn(`[sol] 429, retry #${item.tries} in ${delay}ms for ${signature}`);
      return;
    }
    throw e;
  }
}


// ====== TX handler ======
async function handleSignature(signature, mentionPubkeys) {
  if (seenSignatures.has(signature)) return;
  rememberSig(signature);

  try {
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) return;
    const { meta, blockTime, transaction } = tx;
    const feeLamports = meta?.fee ?? 0;
    const ts = blockTime ? new Date(blockTime * 1000).toISOString() : 'unknown time';

    const pre = meta?.preBalances || [];
    const post = meta?.postBalances || [];
    const accounts = transaction.message.accountKeys.map(k => k.pubkey?.toBase58?.() || k.toBase58());

    const deltas = [];
    for (const watched of mentionPubkeys) {
      const idx = accounts.findIndex(a => a === watched.toBase58());
      if (idx >= 0 && pre[idx] != null && post[idx] != null) {
        const delta = post[idx] - pre[idx];
        if (delta !== 0) deltas.push({ address: watched.toBase58(), deltaLamports: delta });
      }
    }

    const parts = [];
    parts.push('🟣 Новая транзакция в Solana');
    parts.push(`⏱️ Время: ${ts}`);
    parts.push(`💳 Подпись: <a href="${txLink(signature)}">${signature.slice(0,8)}…${signature.slice(-6)}</a>`);
    parts.push(`💸 Комиссия: ${lamportsToSOL(feeLamports)} SOL`);

    if (deltas.length) {
      parts.push('\n📈 Изменения баланса (отслеживаемые):');
      for (const d of deltas) {
        const sign = d.deltaLamports > 0 ? '+' : '';
        parts.push(`• <a href="${addrLink(d.address)}">${d.address.slice(0,4)}…${d.address.slice(-4)}</a>: ${sign}${lamportsToSOL(d.deltaLamports)} SOL`);
      }
    } else {
      parts.push('\nℹ️ Адрес(а) упомянут(ы) в транзакции (возможно SPL):');
      for (const m of mentionPubkeys) {
        const a = m.toBase58();
        parts.push(`• <a href="${addrLink(a)}">${a.slice(0,4)}…${a.slice(-4)}</a>`);
      }
    }

    if (CHANNEL_ID) {
      await bot.sendMessage(CHANNEL_ID, parts.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    } else {
      console.log('[sol] skip send (no CHANNEL_ID):', signature);
    }
  } catch (e) {
    console.error('[sol] handleSignature error:', e);
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
  for (const a of watched) lines.push(`• ${a} ${subscriptions.has(a) ? '✅' : '⚠️'}`);
  if (ADMIN_CHAT_IDS.length) lines.push(`\nРазрешённые админы: ${ADMIN_CHAT_IDS.join(', ')}`);
  await bot.sendMessage(msg.chat.id, lines.join('\n'), { disable_web_page_preview: true });
});

bot.onText(/^\/list$/, async (msg) => {
  const watched = await getWatchedAddresses();
  if (!watched.length) return bot.sendMessage(msg.chat.id, 'Список пуст.');
  await bot.sendMessage(msg.chat.id, `Сейчас отслеживаю:\n` + watched.map(a=>`• <code>${a}</code>`).join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/^\/redis$/, async (msg) => {
  if (!redis) return bot.sendMessage(msg.chat.id, 'Redis: отключён (нет конфигурации).');
  try {
    // покажем DNS хоста для диагностики
    const host = new URL(process.env.REDIS_URL).hostname;
    const a = await dns.lookup(host, { all: true });
    const pong = await redis.ping();
    await bot.sendMessage(msg.chat.id, `Redis OK: ${pong}\nDNS ${host}:\n` + a.map(r=>`${r.address} (${r.family})`).join('\n'));
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Redis error: ${e?.message || e}`);
  }
});

bot.onText(/^\/add(?:\s+(.+))?$/i, async (msg, match) => {
  if (!assertAdmin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Нет прав на изменение списка.');
  const raw = (match[1] || '').trim();
  if (!raw) return bot.sendMessage(msg.chat.id, 'Использование: <code>/add ADDRESS [ADDRESS2 ...]</code>', { parse_mode: 'HTML' });

  const candidates = raw.split(/[,\s]+/).map(s=>s.trim()).filter(Boolean);
  const valid = candidates.filter(isValidPubkey);
  const invalid = candidates.filter(a => !isValidPubkey(a));

  let added = [], skipped = [];
  if (redis) ({ added, skipped } = await addWatchedAddresses(valid));
  else { added = valid.filter(a => !subscriptions.has(a)); skipped = valid.filter(a => subscriptions.has(a)); }

  for (const a of added) await subscribeAddress(a);

  await bot.sendMessage(msg.chat.id, [
    added.length   ? `✅ Добавлены и подписаны: ${added.join(', ')}` : null,
    skipped.length ? `ℹ️ Уже были в списке: ${skipped.join(', ')}`   : null,
    invalid.length ? `❌ Невалидные: ${invalid.join(', ')}`           : null
  ].filter(Boolean).join('\n'), { disable_web_page_preview: true });
});

bot.onText(/^\/remove(?:\s+(.+))?$/i, async (msg, match) => {
  if (!assertAdmin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Нет прав на изменение списка.');
  const raw = (match[1] || '').trim();
  if (!raw) return bot.sendMessage(msg.chat.id, 'Использование: <code>/remove ADDRESS [ADDRESS2 ...]</code>', { parse_mode: 'HTML' });

  const candidates = raw.split(/[,\s]+/).map(s=>s.trim()).filter(Boolean);
  const valid = candidates.filter(isValidPubkey);
  const invalid = candidates.filter(a => !isValidPubkey(a));

  let removed = [], skipped = [];
  if (redis) ({ removed, skipped } = await removeWatchedAddresses(valid));
  else { removed = valid.filter(a => subscriptions.has(a)); skipped = valid.filter(a => !subscriptions.has(a)); }

  for (const a of removed) await unsubscribeAddress(a);

  await bot.sendMessage(msg.chat.id, [
    removed.length ? `🗑 Удалены и отписаны: ${removed.join(', ')}` : null,
    skipped.length ? `ℹ️ Не было в списке: ${skipped.join(', ')}`  : null,
    invalid.length ? `❌ Невалидные: ${invalid.join(', ')}`         : null
  ].filter(Boolean).join('\n'), { disable_web_page_preview: true });
});

// ====== Heartbeat ======
setInterval(() => console.log(`[heartbeat] ${new Date().toISOString()}`), 60_000);
