import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import Redis from 'ioredis';

// ====== ENV ======
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID; // @username или -100...
const HTTPS_RPC = process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta');
const WSS_RPC = process.env.SOLANA_WSS_URL || 'wss://api.mainnet-beta.solana.com';
const EXPLORER = (process.env.EXPLORER || 'solscan').toLowerCase(); // solscan | solanafm | xray

// начальное «семя» адресов (если в Redis пусто) — можно оставить пустым
const SEED_ADDRS = (process.env.MONITOR_ADDRESSES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// кто может менять список адресов: перечислите chat.id через запятую (по желанию)
const ADMIN_CHAT_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ====== GUARDS ======
if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!CHANNEL_ID) throw new Error('TELEGRAM_CHANNEL_ID is required');

// ====== TELEGRAM ======
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ====== REDIS ======
const redisUrl = process.env.REDIS_URL; // например: redis://default:password@host:port
if (!redisUrl) console.warn('REDIS_URL не задан — команды /add и /remove не будут сохраняться между рестартами.');
const redis = redisUrl ? new Redis(redisUrl) : null;
const WATCH_SET_KEY = 'watch:addresses';

// ====== SOLANA CONNECTION ======
const connection = new Connection(HTTPS_RPC, { wsEndpoint: WSS_RPC, commitment: 'confirmed' });

// кеш подписей, чтобы не дублировать при реконнектах
const seenSignatures = new Set();
const SEEN_MAX = 5000;
function rememberSig(sig) {
  seenSignatures.add(sig);
  if (seenSignatures.size > SEEN_MAX) {
    for (const s of seenSignatures) { seenSignatures.delete(s); break; }
  }
}

// управление подписками: address(base58) -> subscriptionId
const subscriptions = new Map();

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
function lamportsToSOL(lamports) {
  return (lamports / 1_000_000_000).toFixed(6);
}

async function handleSignature(signature, mentionPubkeys) {
  if (seenSignatures.has(signature)) return;
  rememberSig(signature);

  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return;
    const { meta, blockTime, transaction } = tx;
    const feeLamports = meta?.fee ?? 0;
    const ts = blockTime ? new Date(blockTime * 1000).toISOString() : 'unknown time';

    const pre = meta?.preBalances || [];
    const post = meta?.postBalances || [];
    const accounts = transaction.message.accountKeys.map(k => k.pubkey?.toBase58?.() || k.toBase58());

    const monitoredDeltas = [];
    for (const watched of mentionPubkeys) {
      const idx = accounts.findIndex(a => a === watched.toBase58());
      if (idx >= 0 && pre[idx] != null && post[idx] != null) {
        const delta = post[idx] - pre[idx];
        if (delta !== 0) {
          monitoredDeltas.push({ address: watched.toBase58(), deltaLamports: delta });
        }
      }
    }

    const title = `🟣 Новая транзакция в Solana`;
    const link = txLink(signature);

    const parts = [];
    parts.push(`${title}`);
    parts.push(`⏱️ Время: ${ts}`);
    parts.push(`💳 Подпись: <a href="${link}">${signature.slice(0,8)}…${signature.slice(-6)}</a>`);
    parts.push(`💸 Комиссия: ${lamportsToSOL(feeLamports)} SOL`);

    if (monitoredDeltas.length > 0) {
      parts.push(`\n📈 Изменения баланса (для отслеживаемых):`);
      for (const d of monitoredDeltas) {
        const sign = d.deltaLamports > 0 ? '+' : '';
        parts.push(
          `• <a href="${addrLink(d.address)}">${d.address.slice(0,4)}…${d.address.slice(-4)}</a>: ` +
          `${sign}${lamportsToSOL(d.deltaLamports)} SOL`
        );
      }
    } else {
      parts.push(`\nℹ️ Адрес(а) упомянут(ы) в транзакции (возможно SPL).`);
      for (const m of mentionPubkeys) {
        const a = m.toBase58();
        parts.push(`• <a href="${addrLink(a)}">${a.slice(0,4)}…${a.slice(-4)}</a>`);
      }
    }

    await bot.sendMessage(CHANNEL_ID, parts.join('\n'), {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error('handleSignature error', e);
  }
}

// ====== WATCH LIST (Redis-backed) ======
async function getWatchedAddresses() {
  if (!redis) return SEED_ADDRS;
  const members = await redis.smembers(WATCH_SET_KEY);
  return members;
}

async function addWatchedAddresses(addrs) {
  if (!redis) return { added: [], skipped: addrs };
  const added = [];
  for (const a of addrs) {
    const res = await redis.sadd(WATCH_SET_KEY, a);
    if (res === 1) added.push(a);
  }
  return { added, skipped: addrs.filter(a => !added.includes(a)) };
}

async function removeWatchedAddresses(addrs) {
  if (!redis) return { removed: [], skipped: addrs };
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
    console.log('Инициализировал Redis начальными адресами из MONITOR_ADDRESSES.');
  }
}

// ====== SUBSCRIPTION MGMT ======
function isValidPubkey(a) {
  try { new PublicKey(a); return true; } catch { return false; }
}

async function subscribeAddress(address) {
  if (subscriptions.has(address)) return;
  const pk = new PublicKey(address);
  const subId = connection.onLogs({ mentions: [pk.toBase58()] }, async (logInfo) => {
    await handleSignature(logInfo.signature, [pk]);
  }, 'confirmed');
  subscriptions.set(address, subId);
  console.log(`Подписался на ${address} (subId=${subId})`);
}

async function unsubscribeAddress(address) {
  const subId = subscriptions.get(address);
  if (subId != null) {
    try {
      await connection.removeOnLogsListener(subId);
      console.log(`Отписался от ${address} (subId=${subId})`);
    } catch (e) {
      console.warn(`Не удалось снять подписку ${address}:`, e?.message || e);
    }
    subscriptions.delete(address);
  }
}

async function resubscribeAll(addresses) {
  // снять лишние
  for (const existing of subscriptions.keys()) {
    if (!addresses.includes(existing)) await unsubscribeAddress(existing);
  }
  // добавить недостающие
  for (const a of addresses) {
    if (!subscriptions.has(a)) await subscribeAddress(a);
  }
}

async function bootstrap() {
  await ensureSeeded();
  const list = (await getWatchedAddresses()).filter(isValidPubkey);
  if (list.length === 0 && SEED_ADDRS.length > 0) {
    // локальный режим без Redis: подпишемся на SEED_ADDRS
    console.log('Адресов в Redis нет — использую MONITOR_ADDRESSES из .env (неперсистентно).');
    for (const a of SEED_ADDRS.filter(isValidPubkey)) await subscribeAddress(a);
  } else {
    for (const a of list) await subscribeAddress(a);
  }
}

bootstrap().catch(console.error);

// ====== COMMANDS ======
function assertAdmin(msg) {
  if (ADMIN_CHAT_IDS.length === 0) return true; // не ограничиваем, если переменная не задана
  return ADMIN_CHAT_IDS.includes(String(msg.chat.id));
}

bot.onText(/^\/ping$/, (msg) => bot.sendMessage(msg.chat.id, 'pong'));

bot.onText(/^\/status$/, async (msg) => {
  const watched = await getWatchedAddresses();
  const lines = [];
  lines.push(`RPC (HTTPS): ${HTTPS_RPC}`);
  lines.push(`RPC (WSS): ${WSS_RPC}`);
  lines.push(`Канал: ${CHANNEL_ID}`);
  lines.push(`Отслеживаемые адреса (${watched.length}):`);
  for (const a of watched) {
    const mark = subscriptions.has(a) ? '✅' : '⚠️';
    lines.push(`• ${a} ${mark}`);
  }
  if (ADMIN_CHAT_IDS.length) {
    lines.push(`\nРазрешённые админы: ${ADMIN_CHAT_IDS.join(', ')}`);
  }
  await bot.sendMessage(msg.chat.id, lines.join('\n'), { disable_web_page_preview: true });
});

bot.onText(/^\/list$/, async (msg) => {
  const watched = await getWatchedAddresses();
  if (watched.length === 0) return bot.sendMessage(msg.chat.id, 'Список пуст.');
  const text = watched.map(a => `• <code>${a}</code>`).join('\n');
  return bot.sendMessage(msg.chat.id, `Сейчас отслеживаю:\n${text}`, { parse_mode: 'HTML' });
});

bot.onText(/^\/add(?:\s+(.+))?$/i, async (msg, match) => {
  if (!assertAdmin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Нет прав на изменение списка.');
  const raw = (match[1] || '').trim();
  if (!raw) return bot.sendMessage(msg.chat.id, 'Использование: <code>/add ADDRESS [ADDRESS2 ...]</code>', { parse_mode: 'HTML' });

  const candidates = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const valid = candidates.filter(isValidPubkey);
  const invalid = candidates.filter(a => !isValidPubkey(a));

  if (valid.length === 0) {
    return bot.sendMessage(msg.chat.id, `Не найдено валидных адресов. Невалидные: ${invalid.join(', ')}`);
  }

  let added = [], skipped = [];
  if (redis) ({ added, skipped } = await addWatchedAddresses(valid));
  else { // без Redis — просто подпишемся на текущий сеанс
    added = valid.filter(a => !subscriptions.has(a));
    skipped = valid.filter(a => subscriptions.has(a));
  }

  for (const a of added) await subscribeAddress(a);
  await bot.sendMessage(
    msg.chat.id,
    [
      added.length ? `✅ Добавлены и подписаны: ${added.join(', ')}` : null,
      skipped.length ? `ℹ️ Уже были в списке: ${skipped.join(', ')}` : null,
      invalid.length ? `❌ Невалидные: ${invalid.join(', ')}` : null
    ].filter(Boolean).join('\n')
  );
});

bot.onText(/^\/remove(?:\s+(.+))?$/i, async (msg, match) => {
  if (!assertAdmin(msg)) return bot.sendMessage(msg.chat.id, '⛔ Нет прав на изменение списка.');
  const raw = (match[1] || '').trim();
  if (!raw) return bot.sendMessage(msg.chat.id, 'Использование: <code>/remove ADDRESS [ADDRESS2 ...]</code>', { parse_mode: 'HTML' });

  const candidates = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const valid = candidates.filter(isValidPubkey);
  const invalid = candidates.filter(a => !isValidPubkey(a));

  let removed = [], skipped = [];
  if (redis) ({ removed, skipped } = await removeWatchedAddresses(valid));
  else {
    removed = valid.filter(a => subscriptions.has(a));
    skipped = valid.filter(a => !subscriptions.has(a));
  }

  for (const a of removed) await unsubscribeAddress(a);

  await bot.sendMessage(
    msg.chat.id,
    [
      removed.length ? `🗑 Удалены и отписаны: ${removed.join(', ')}` : null,
      skipped.length ? `ℹ️ Не было в списке: ${skipped.join(', ')}` : null,
      invalid.length ? `❌ Невалидные: ${invalid.join(', ')}` : null
    ].filter(Boolean).join('\n')
  );
});

// ====== HEARTBEAT ======
setInterval(() => console.log(`[heartbeat] ${new Date().toISOString()}`), 60_000);
