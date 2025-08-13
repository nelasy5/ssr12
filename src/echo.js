// src/echo.js
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const bot = new TelegramBot(TOKEN, { polling: true });

(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true }); // выключим вебхук на всякий
    const me = await bot.getMe();
    console.log('[tg] online as @' + me.username);
  } catch (e) {
    console.error('[tg] init error:', e?.message || e);
  }
})();

bot.on('message', (msg) => {
  console.log('[tg] incoming from', msg.chat.id, 'text=', msg.text);
  bot.sendMessage(msg.chat.id, `✅ Я на связи. Получил: ${msg.text ?? '(без текста)'}\nchat.id=${msg.chat.id}`);
});

bot.on('polling_error', (err) => console.error('[tg] polling_error:', err?.message || err));
bot.on('webhook_error',  (err) => console.error('[tg] webhook_error:', err?.message || err));
