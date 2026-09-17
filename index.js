'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const bedrock = require('bedrock-protocol');
const TelegramBot = require('node-telegram-bot-api');

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const AUTH_CACHE_PATH = path.join(ROOT_DIR, 'auth_cache');
const BOT_TOKEN = process.env.BOT_TOKEN;
const ACCESS_DENIED_MESSAGE = '⛔ لا تملك صلاحية استخدام هذا البوت.';
const ALLOWLIST_USAGE =
  'الاستخدام:\n<code>/allowlist</code> لعرض القائمة\n<code>/allowlist add CHAT_ID</code> للإضافة\n<code>/allowlist remove CHAT_ID</code> للحذف';

const DEFAULT_CONFIG = Object.freeze({
  ip: '127.0.0.1',
  port: 19132,
  username: 'Bot_Player',
  version: '1.26.45',
  allowedChatIds: [],
});

const BUTTONS = Object.freeze({
  server: 'config_server',
  username: 'config_username',
  version: 'config_version',
  connect: 'connect',
  startAfk: 'start_afk',
  stopAfk: 'stop_afk',
  chat: 'chat',
  command: 'command',
  status: 'status',
  disconnect: 'disconnect',
  menu: 'menu',
});

function normalizeChatId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

function normalizeAllowedChatIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeChatId).filter(Boolean))];
}

function parseAllowlistCommand(text) {
  const match = String(text)
    .trim()
    .match(/^\/([a-z][a-z0-9_]*)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = match[2] ? match[2].trim().split(/\s+/).filter(Boolean) : [];
  if (['allowlist', 'list'].includes(command)) {
    if (args.length === 0 || (args.length === 1 && args[0].toLowerCase() === 'list')) {
      return { action: 'list' };
    }
    if (args.length === 2 && ['add', 'remove'].includes(args[0].toLowerCase())) {
      return { action: args[0].toLowerCase(), chatId: normalizeChatId(args[1]) };
    }
    if (command === 'allowlist' && args.length === 1) {
      return { action: 'add', chatId: normalizeChatId(args[0]) };
    }
    return { action: 'invalid' };
  }
  if (['allow', 'add', 'addchat', 'add_chat'].includes(command) && args.length === 1) {
    return { action: 'add', chatId: normalizeChatId(args[0]) };
  }
  if (['deny', 'remove', 'removechat', 'remove_chat'].includes(command) && args.length === 1) {
    return { action: 'remove', chatId: normalizeChatId(args[0]) };
  }
  return null;
}

function log(message, error) {
  if (error) {
    console.error(`[minecraft-bot] ${message}`, error);
    return;
  }
  console.log(`[minecraft-bot] ${message}`);
}

function mergeConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ip: typeof source.ip === 'string' && source.ip.trim() ? source.ip.trim() : DEFAULT_CONFIG.ip,
    port: Number.isInteger(Number(source.port)) ? Number(source.port) : DEFAULT_CONFIG.port,
    username:
      typeof source.username === 'string' && source.username.trim()
        ? source.username.trim()
        : DEFAULT_CONFIG.username,
    version:
      typeof source.version === 'string' && source.version.trim()
        ? source.version.trim()
        : DEFAULT_CONFIG.version,
    allowedChatIds: normalizeAllowedChatIds(source.allowedChatIds),
  };
}

function validateConfig(config) {
  if (!config.ip || config.ip.length > 253) {
    throw new Error('عنوان السيرفر غير صالح.');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('المنفذ يجب أن يكون رقماً بين 1 و 65535.');
  }
  if (!config.username || config.username.length > 16) {
    throw new Error('اسم اللاعب يجب ألا يتجاوز 16 حرفاً.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(config.version)) {
    throw new Error('إصدار اللعبة يجب أن يكون بالشكل 1.26.45.');
  }
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = mergeConfig(JSON.parse(raw));
    validateConfig(config);
    return config;
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      log('config.json غير صالح، سيتم استخدام الإعدادات الافتراضية.', error);
    }
    const config = { ...DEFAULT_CONFIG };
    saveConfig(config);
    return config;
  }
}

function saveConfig(config) {
  const normalized = mergeConfig(config);
  validateConfig(normalized);
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, CONFIG_PATH);
  return normalized;
}

function parseServerInput(text) {
  const value = text.trim();
  let ip = value;
  let port = 19132;

  const whitespaceParts = value.split(/\s+/);
  if (whitespaceParts.length === 2 && /^\d+$/.test(whitespaceParts[1])) {
    ip = whitespaceParts[0];
    port = Number(whitespaceParts[1]);
  } else {
    const portMatch = value.match(/^(.*):(\d+)$/);
    if (portMatch) {
      ip = portMatch[1];
      port = Number(portMatch[2]);
    }
  }

  if (!ip || ip.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('البيانات غير صحيحة. أرسل العنوان والمنفذ مثل:\n`play.example.com:19132`');
  }
  return { ip, port };
}

function escapeTelegramText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function limitTelegramText(text, maxLength = 3800) {
  const value = String(text ?? '');
  return value.length > maxLength ? `${value.slice(0, maxLength - 40)}\n… تم اختصار الرسالة` : value;
}

function connectionLabel(manager) {
  if (manager.isConnecting) return 'جارٍ الاتصال';
  if (manager.client) return manager.afkTimer ? 'متصل ويعمل' : 'متصل ومتوقف';
  return 'غير متصل';
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '➕ إضافة/تعديل سيرفر', callback_data: BUTTONS.server },
        { text: '🏷️ تغيير اسم اللاعب', callback_data: BUTTONS.username },
      ],
      [
        { text: '⚙️ تغيير إصدار اللعبة', callback_data: BUTTONS.version },
        { text: '🚀 دخول إلى السيرفر', callback_data: BUTTONS.connect },
      ],
      [
        { text: '⚡ تشغيل اللاعب', callback_data: BUTTONS.startAfk },
        { text: '⏸️ إيقاف اللاعب', callback_data: BUTTONS.stopAfk },
      ],
      [
        { text: '💬 كتابة في الشات', callback_data: BUTTONS.chat },
        { text: '📜 تنفيذ أمر سيرفر', callback_data: BUTTONS.command },
      ],
      [
        { text: '📊 حالة اللاعب والاعدادات', callback_data: BUTTONS.status },
        { text: '🛑 خروج من السيرفر', callback_data: BUTTONS.disconnect },
      ],
    ],
  };
}

class PlayerManager {
  constructor(notify) {
    this.notify = notify;
    this.client = null;
    this.config = loadConfig();
    this.isConnecting = false;
    this.afkTimer = null;
    this.runtimeEntityId = 0;
    this.health = null;
    this.position = null;
    this.rotation = { yaw: 0, pitch: 0, headYaw: 0 };
    this.connectedAt = null;
    this.lastError = null;
    this.disconnectNotified = false;
  }

  refreshConfig() {
    this.config = loadConfig();
    return this.config;
  }

  saveConfig(patch) {
    this.config = saveConfig({ ...this.config, ...patch });
    return this.config;
  }

  async connect() {
    this.refreshConfig();
    if (this.client || this.isConnecting) {
      return false;
    }

    this.isConnecting = true;
    this.lastError = null;
    this.disconnectNotified = false;
    await this.notify(
      `🚀 جارٍ الاتصال بـ <b>${escapeTelegramText(this.config.ip)}:${this.config.port}</b> باسم <b>${escapeTelegramText(this.config.username)}</b>...`,
    );

    const savedConfig = this.config;
    const clientOptions = {
      host: savedConfig.ip || '127.0.0.1',
      port: parseInt(savedConfig.port, 10) || 19132,
      username: savedConfig.username || 'Bot_Player',
      version: savedConfig.version || '1.26.45',
      offline: true,
      deviceOS: 1,
      authTitle: '0000000044124D4E',
      profilesFolder: './auth_cache',
      // The pure-JavaScript backend avoids native C++ build requirements on Replit.
      raknetBackend: 'jsp-raknet',
    };

    try {
      await fsp.mkdir(AUTH_CACHE_PATH, { recursive: true });
      const client = bedrock.createClient(clientOptions);
      this.client = client;
      this.isConnecting = false;
      this.attachClientEvents(client);
      return true;
    } catch (error) {
      this.isConnecting = false;
      this.lastError = error;
      this.client = null;
      await this.notify(`❌ تعذر بدء الاتصال:\n${escapeTelegramText(error.message || error)}`);
      return false;
    }
  }

  attachClientEvents(client) {
    client.on('connect', () => {
      this.notify('🔌 تم فتح اتصال الشبكة، بانتظار دخول اللاعب إلى العالم.');
    });

    client.on('join', () => {
      this.connectedAt = Date.now();
      this.disconnectNotified = false;
      this.notify('✅ دخل اللاعب إلى السيرفر بنجاح.');
    });

    client.on('spawn', () => {
      this.connectedAt = this.connectedAt || Date.now();
      this.notify('🌍 تم تحميل العالم. يمكنك تشغيل اللاعب الآن.');
    });

    client.on('start_game', (packet) => {
      this.runtimeEntityId = Number(packet.runtime_entity_id || packet.entity_id || 0);
      if (packet.player_position) {
        this.position = { ...packet.player_position };
      } else if (packet.position) {
        this.position = { ...packet.position };
      }
    });

    client.on('move_player', (packet) => {
      if (packet.runtime_entity_id && this.runtimeEntityId && Number(packet.runtime_entity_id) !== this.runtimeEntityId) {
        return;
      }
      if (packet.position) this.position = { ...packet.position };
      if (typeof packet.yaw === 'number') this.rotation.yaw = packet.yaw;
      if (typeof packet.pitch === 'number') this.rotation.pitch = packet.pitch;
      if (typeof packet.head_yaw === 'number') this.rotation.headYaw = packet.head_yaw;
    });

    client.on('update_attributes', (packet) => {
      const healthAttribute = packet.attributes?.find(
        (attribute) => attribute.name === 'minecraft:health' || attribute.name === 'health',
      );
      if (healthAttribute) this.health = Number(healthAttribute.current);
    });

    client.on('set_health', (packet) => {
      if (typeof packet.health === 'number') this.health = packet.health;
    });

    client.on('text', (packet) => {
      this.forwardServerText(packet);
    });

    client.on('kick', (packet) => {
      const reason = packet?.message || packet?.reason || 'تم طرد اللاعب من السيرفر.';
      this.notify(`⚠️ تم طرد اللاعب:\n${escapeTelegramText(reason)}`);
      this.clearClient(client);
    });

    client.on('error', (error) => {
      this.lastError = error;
      this.notify(`❌ خطأ في اتصال اللاعب:\n${escapeTelegramText(error?.message || error)}`);
    });

    client.on('end', (reason) => {
      if (!this.disconnectNotified) {
        this.notify(`🔌 انتهى اتصال اللاعب${reason ? `:\n${escapeTelegramText(reason)}` : '.'}`);
      }
      this.clearClient(client);
    });

    client.on('close', () => {
      this.clearClient(client);
    });
  }

  forwardServerText(packet) {
    const message = packet?.message;
    const source = packet?.source_name || packet?.sourceName;
    const type = String(packet?.type || packet?.text_type || '').toLowerCase();
    const parameters = Array.isArray(packet?.parameters) ? ` ${packet.parameters.join(' ')}` : '';
    if (!message && !source) return;

    let prefix = '💬 رسالة السيرفر';
    if (type.includes('whisper') || type.includes('tell')) prefix = '📩 همسة مباشرة';
    if (type.includes('chat')) prefix = '💬 شات';
    const sender = source ? ` من <b>${escapeTelegramText(source)}</b>` : '';
    const body = escapeTelegramText(`${message || ''}${parameters}`);
    this.notify(`${prefix}${sender}:\n${body}`);
  }

  clearClient(client) {
    if (this.client !== client) return;
    this.stopAfk(false);
    this.client = null;
    this.isConnecting = false;
    this.connectedAt = null;
    this.runtimeEntityId = 0;
  }

  async disconnect() {
    const client = this.client;
    this.stopAfk(false);
    this.disconnectNotified = true;
    this.client = null;
    this.isConnecting = false;
    this.connectedAt = null;
    this.runtimeEntityId = 0;
    if (!client) return false;

    try {
      if (typeof client.disconnect === 'function') {
        client.disconnect('تم طلب الخروج من Telegram');
      } else if (typeof client.close === 'function') {
        client.close();
      }
      await this.notify('🛑 تم خروج اللاعب من السيرفر.');
      return true;
    } catch (error) {
      this.lastError = error;
      await this.notify(`⚠️ انتهى الاتصال مع وجود تنبيه:\n${escapeTelegramText(error.message || error)}`);
      return false;
    }
  }

  sendPacket(name, payload) {
    if (!this.client) return false;
    try {
      if (typeof this.client.queue === 'function') {
        this.client.queue(name, payload);
      } else {
        this.client.write(name, payload);
      }
      return true;
    } catch (error) {
      this.lastError = error;
      log(`تعذر إرسال حزمة ${name}`, error);
      return false;
    }
  }

  sendChat(message) {
    if (!this.client) throw new Error('اللاعب غير متصل بالسيرفر.');
    const text = message.trim();
    if (!text) throw new Error('رسالة الشات فارغة.');
    if (typeof this.client.chat === 'function') {
      this.client.chat(text);
      return;
    }
    if (!this.sendPacket('text', { type: 'chat', needs_translation: false, source_name: this.config.username, message: text, xuid: '', platform_chat_id: '' })) {
      throw new Error('تعذر إرسال رسالة الشات.');
    }
  }

  sendCommand(command) {
    if (!this.client) throw new Error('اللاعب غير متصل بالسيرفر.');
    const text = command.trim().startsWith('/') ? command.trim() : `/${command.trim()}`;
    if (typeof this.client.command === 'function') {
      this.client.command(text);
      return;
    }
    if (!this.sendPacket('command_request', { command: text, origin: { type: 0, uuid: '', request_id: '' }, internal: false, version: 52 })) {
      throw new Error('تعذر إرسال الأمر.');
    }
  }

  startAfk() {
    if (!this.client) throw new Error('اتصل بالسيرفر أولاً.');
    if (this.afkTimer) return false;
    this.scheduleAfkStep(1200);
    return true;
  }

  scheduleAfkStep(delay) {
    this.afkTimer = setTimeout(() => {
      this.afkTimer = null;
      this.performAfkStep();
      if (this.client) {
        const nextDelay = 25000 + Math.floor(Math.random() * 30000);
        this.scheduleAfkStep(nextDelay);
      }
    }, delay);
  }

  performAfkStep() {
    if (!this.client) return;
    const direction = Math.random() > 0.5 ? 1 : -1;
    const shouldJump = Math.random() > 0.45;
    const shouldSneak = Math.random() > 0.78;
    const yawChange = (Math.random() * 70 + 25) * direction;
    this.rotation.yaw = ((this.rotation.yaw + yawChange + 540) % 360) - 180;
    this.rotation.headYaw = this.rotation.yaw;

    const currentPosition = this.position || { x: 0, y: 0, z: 0 };
    const moveVector = {
      x: Number((Math.cos((this.rotation.yaw * Math.PI) / 180) * 0.35).toFixed(3)),
      z: Number((Math.sin((this.rotation.yaw * Math.PI) / 180) * 0.35).toFixed(3)),
    };
    // Bedrock 1.26.40+ encodes input flags as an array of enum ordinals,
    // not the old bitfield used by earlier protocol versions.
    const inputData = shouldJump ? [6] : shouldSneak ? [8] : [12];
    const payload = {
      pitch: this.rotation.pitch,
      yaw: this.rotation.yaw,
      position: currentPosition,
      move_vector: moveVector,
      head_yaw: this.rotation.headYaw,
      input_data: inputData,
      input_mode: 2,
      play_mode: 0,
      interaction_model: 0,
      interact_rotation: { x: this.rotation.pitch, y: this.rotation.yaw },
      tick: 0,
      delta: { x: 0, y: 0, z: 0 },
      transaction_presence: false,
      item_stack_request_presence: false,
      block_action_presence: false,
      vehicle_rotation_presence: false,
      predicted_vehicle_presence: false,
      analogue_move_vector: { x: moveVector.x, y: moveVector.z },
      camera_orientation: { x: 0, y: 0, z: 0 },
      raw_move_vector: { x: moveVector.x, y: moveVector.z },
    };

    if (!this.sendPacket('player_auth_input', payload)) {
      this.sendPacket('move_player', {
        runtime_entity_id: this.runtimeEntityId,
        position: currentPosition,
        pitch: this.rotation.pitch,
        yaw: this.rotation.yaw,
        head_yaw: this.rotation.headYaw,
        on_ground: true,
        ridden_runtime_entity_id: 0,
        teleport_cause: 0,
        teleport_source_entity_type: 0,
        tick: 0,
      });
    }
  }

  stopAfk(notifyUser = true) {
    if (!this.afkTimer) return false;
    clearTimeout(this.afkTimer);
    this.afkTimer = null;
    if (notifyUser) this.notify('⏸️ تم إيقاف حركة اللاعب التلقائية.');
    return true;
  }

  statusText() {
    const position = this.position
      ? `X: ${Number(this.position.x).toFixed(2)} | Y: ${Number(this.position.y).toFixed(2)} | Z: ${Number(this.position.z).toFixed(2)}`
      : 'غير متاحة بعد';
    const health = this.health == null ? 'غير متاحة بعد' : `${this.health}`;
    const lastError = this.lastError ? `\nآخر خطأ: ${escapeTelegramText(this.lastError.message || this.lastError)}` : '';
    return [
      '📊 <b>حالة اللاعب والإعدادات</b>',
      '',
      `الحالة: <b>${connectionLabel(this)}</b>`,
      `السيرفر: <code>${escapeTelegramText(this.config.ip)}:${this.config.port}</code>`,
      `اسم اللاعب: <code>${escapeTelegramText(this.config.username)}</code>`,
      `إصدار Bedrock: <code>${escapeTelegramText(this.config.version)}</code>`,
      `الصحة: <code>${health}</code>`,
      `الإحداثيات: <code>${position}</code>`,
      `Anti-AFK: <b>${this.afkTimer ? 'مفعّل' : 'متوقف'}</b>${lastError}`,
    ].join('\n');
  }
}

class TelegramController {
  constructor({ bot, player } = {}) {
    this.bot = bot || new TelegramBot(BOT_TOKEN, { polling: true });
    this.pending = new Map();
    this.activeChatId = null;
    this.player = player || new PlayerManager((message) => this.notify(message));
    this.registerHandlers();
  }

  isAuthorized(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    return normalizedChatId !== null && this.player.config.allowedChatIds.includes(normalizedChatId);
  }

  async rejectUnauthorized(chatId, callbackQueryId) {
    if (callbackQueryId) {
      try {
        await this.bot.answerCallbackQuery(callbackQueryId);
      } catch (error) {
        log('تعذر تأكيد زر Telegram للمستخدم غير المصرح له', error);
      }
    }
    if (chatId !== undefined && chatId !== null) {
      await this.send(chatId, ACCESS_DENIED_MESSAGE);
    }
  }

  async notify(message) {
    const activeChatId = this.activeChatId;
    if (activeChatId === null || activeChatId === undefined || !this.isAuthorized(activeChatId)) {
      log(`لا يوجد مستخدم نشط لإرسال التنبيه: ${String(message).replace(/<[^>]*>/g, '')}`);
      return;
    }
    try {
      await this.bot.sendMessage(activeChatId, limitTelegramText(message), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      log('تعذر إرسال تنبيه Telegram', error);
    }
  }

  registerHandlers() {
    this.bot.on('polling_error', (error) => log('Telegram polling error', error));

    this.bot.on('callback_query', async (query) => {
      await this.handleCallback(query);
    });

    this.bot.on('message', async (message) => {
      if (!message || !message.chat || typeof message.text !== 'string' || !message.text) return;
      if (!this.isAuthorized(message.chat.id)) {
        await this.rejectUnauthorized(message.chat.id);
        return;
      }

      if (/^\/start(?:@\w+)?$/.test(message.text)) {
        await this.showMenu(message.chat.id);
        return;
      }
      if (/^\/cancel(?:@\w+)?$/.test(message.text)) {
        this.pending.delete(message.chat.id);
        await this.send(message.chat.id, 'تم إلغاء العملية.', mainKeyboard());
        return;
      }
      if (message.text.startsWith('/')) {
        await this.handleAllowlistCommand(message.chat.id, message.text);
        return;
      }

      this.activeChatId = message.chat.id;
      const pending = this.pending.get(message.chat.id);
      if (!pending) {
        await this.send(message.chat.id, 'اختر عملية من القائمة الرئيسية:', mainKeyboard());
        return;
      }
      await this.handlePendingInput(message.chat.id, message.text.trim(), pending);
    });
  }

  async handleAllowlistCommand(chatId, text) {
    const command = parseAllowlistCommand(text);
    if (!command) return false;

    this.activeChatId = chatId;
    this.pending.delete(chatId);

    if (command.action === 'invalid' || (command.action !== 'list' && !command.chatId)) {
      await this.send(chatId, ALLOWLIST_USAGE);
      return true;
    }

    try {
      const allowedChatIds = normalizeAllowedChatIds(this.player.config.allowedChatIds);
      if (command.action === 'list') {
        const entries = allowedChatIds.length
          ? allowedChatIds.map((id) => `<code>${escapeTelegramText(id)}</code>`).join('\n')
          : 'لا توجد محادثات مصرح بها.';
        await this.send(chatId, `📋 <b>المحادثات المصرح بها</b>\n${entries}`);
        return true;
      }

      if (command.action === 'add') {
        if (allowedChatIds.includes(command.chatId)) {
          await this.send(chatId, `ℹ️ المحادثة <code>${escapeTelegramText(command.chatId)}</code> مضافة بالفعل.`);
          return true;
        }
        this.player.saveConfig({ allowedChatIds: [...allowedChatIds, command.chatId] });
        await this.send(chatId, `✅ تمت إضافة المحادثة <code>${escapeTelegramText(command.chatId)}</code>.`);
        return true;
      }

      if (!allowedChatIds.includes(command.chatId)) {
        await this.send(chatId, `ℹ️ المحادثة <code>${escapeTelegramText(command.chatId)}</code> غير موجودة في القائمة.`);
        return true;
      }
      if (allowedChatIds.length === 1) {
        await this.send(chatId, '⚠️ لا يمكن حذف آخر محادثة مصرح بها حتى لا تفقد التحكم بالبوت.');
        return true;
      }

      this.player.saveConfig({
        allowedChatIds: allowedChatIds.filter((id) => id !== command.chatId),
      });
      if (normalizeChatId(this.activeChatId) === command.chatId) {
        this.activeChatId = allowedChatIds.find((id) => id !== command.chatId) || null;
      }
      await this.send(chatId, `✅ تمت إزالة المحادثة <code>${escapeTelegramText(command.chatId)}</code>.`);
      return true;
    } catch (error) {
      await this.send(chatId, `❌ ${escapeTelegramText(error.message || error)}`);
      return true;
    }
  }

  async send(chatId, text, replyMarkup) {
    try {
      await this.bot.sendMessage(chatId, limitTelegramText(text), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (error) {
      log('تعذر إرسال رسالة Telegram', error);
    }
  }

  async showMenu(chatId) {
    this.activeChatId = chatId;
    this.pending.delete(chatId);
    await this.send(
      chatId,
      [
        '🎮 <b>مرحباً بك في متحكم Minecraft Bedrock</b>',
        '',
        'استخدم الأزرار لإعداد السيرفر والتحكم باللاعب. الإعدادات تُحفظ تلقائياً في config.json.',
        'إدارة الوصول: <code>/allowlist add CHAT_ID</code> أو <code>/allowlist remove CHAT_ID</code>.',
        '',
        this.player.statusText(),
      ].join('\n'),
      mainKeyboard(),
    );
  }

  async prompt(chatId, kind, text) {
    this.activeChatId = chatId;
    this.pending.set(chatId, { kind });
    await this.send(chatId, `${text}\n\nأرسل /cancel للإلغاء.`);
  }

  async handleCallback(query) {
    const chatId = query?.message?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    if (!this.isAuthorized(chatId)) {
      await this.rejectUnauthorized(chatId, query.id);
      return;
    }
    this.activeChatId = chatId;
    try {
      await this.bot.answerCallbackQuery(query.id);
    } catch (error) {
      log('تعذر تأكيد زر Telegram', error);
    }

    switch (query.data) {
      case BUTTONS.menu:
        return this.showMenu(chatId);
      case BUTTONS.server:
        return this.prompt(chatId, 'server', 'أرسل عنوان السيرفر والمنفذ بهذا الشكل:\n<code>play.example.com:19132</code>\nأو:\n<code>play.example.com 19132</code>');
      case BUTTONS.username:
        return this.prompt(chatId, 'username', 'أرسل اسم اللاعب الجديد (حتى 16 حرفاً):');
      case BUTTONS.version:
        return this.prompt(chatId, 'version', 'أرسل إصدار Bedrock مثل:\n<code>1.26.45</code>');
      case BUTTONS.connect:
        return this.connect(chatId);
      case BUTTONS.startAfk:
        return this.toggleAfk(chatId, true);
      case BUTTONS.stopAfk:
        return this.toggleAfk(chatId, false);
      case BUTTONS.chat:
        return this.prompt(chatId, 'chat', 'أرسل رسالة الشات التي تريد كتابتها داخل اللعبة:');
      case BUTTONS.command:
        return this.prompt(chatId, 'command', 'أرسل أمر السيرفر مثل:\n<code>/spawn</code>\nأو:\n<code>/tp لاعب 0 80 0</code>');
      case BUTTONS.status:
        return this.send(chatId, this.player.statusText(), mainKeyboard());
      case BUTTONS.disconnect:
        await this.player.disconnect();
        return this.send(chatId, this.player.statusText(), mainKeyboard());
      default:
        return this.send(chatId, 'الزر غير معروف.', mainKeyboard());
    }
  }

  async connect(chatId) {
    await this.player.connect();
    await this.send(chatId, this.player.statusText(), mainKeyboard());
  }

  async toggleAfk(chatId, enabled) {
    try {
      if (enabled) {
        const started = this.player.startAfk();
        await this.send(chatId, started ? '⚡ تم تشغيل Anti-AFK والحركة الطبيعية.' : '⚡ Anti-AFK يعمل بالفعل.', mainKeyboard());
      } else {
        const stopped = this.player.stopAfk();
        await this.send(chatId, stopped ? '⏸️ تم إيقاف Anti-AFK.' : '⏸️ Anti-AFK متوقف بالفعل.', mainKeyboard());
      }
    } catch (error) {
      await this.send(chatId, `❌ ${escapeTelegramText(error.message || error)}`, mainKeyboard());
    }
  }

  async handlePendingInput(chatId, input, pending) {
    try {
      switch (pending.kind) {
        case 'server': {
          const server = parseServerInput(input);
          this.player.saveConfig(server);
          await this.send(chatId, `✅ تم حفظ السيرفر:\n<code>${escapeTelegramText(server.ip)}:${server.port}</code>`, mainKeyboard());
          break;
        }
        case 'username': {
          if (!input || input.length > 16) throw new Error('اسم اللاعب يجب ألا يتجاوز 16 حرفاً.');
          this.player.saveConfig({ username: input });
          await this.send(chatId, `✅ تم حفظ اسم اللاعب: <code>${escapeTelegramText(input)}</code>`, mainKeyboard());
          break;
        }
        case 'version': {
          if (!/^\d+\.\d+\.\d+$/.test(input)) throw new Error('الإصدار يجب أن يكون بالشكل 1.26.45.');
          this.player.saveConfig({ version: input });
          await this.send(chatId, `✅ تم حفظ إصدار اللعبة: <code>${escapeTelegramText(input)}</code>`, mainKeyboard());
          break;
        }
        case 'chat':
          this.player.sendChat(input);
          await this.send(chatId, '✅ تم إرسال الرسالة إلى شات اللعبة.', mainKeyboard());
          break;
        case 'command':
          this.player.sendCommand(input);
          await this.send(chatId, `✅ تم إرسال الأمر: <code>${escapeTelegramText(input)}</code>`, mainKeyboard());
          break;
        default:
          await this.send(chatId, 'العملية غير معروفة.', mainKeyboard());
      }
    } catch (error) {
      await this.send(chatId, `❌ ${escapeTelegramText(error.message || error)}`);
    } finally {
      this.pending.delete(chatId);
    }
  }
}

function createController() {
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is missing. Add it to Replit Secrets before starting the bot.');
  }
  return new TelegramController();
}

let controller;

async function shutdown(signal) {
  log(`استلام ${signal}، يتم إيقاف اللاعب بأمان...`);
  await controller.player.disconnect();
  controller.bot.stopPolling().catch(() => {});
  process.exit(0);
}

if (require.main === module) {
  controller = createController();
  log(`تم تشغيل Telegram Control Bot. الإعدادات الحالية: ${controller.player.config.ip}:${controller.player.config.port}`);
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  ACCESS_DENIED_MESSAGE,
  BUTTONS,
  TelegramController,
  PlayerManager,
  createController,
  mergeConfig,
  normalizeAllowedChatIds,
  normalizeChatId,
};
