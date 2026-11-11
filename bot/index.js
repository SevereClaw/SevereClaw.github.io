// SevereClaw presence bot.
// Следит за статусами Discord у тебя и друзей на твоём сервере
// и выкладывает их в публичный gist, откуда их читает severeclaw.github.io.

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Events } = require('discord.js');

const CFG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CFG_PATH)) {
  console.error('Нет config.json. Скопируй config.example.json в config.json и заполни его.');
  process.exit(1);
}
let cfg;
try {
  // Блокнот иногда сохраняет файл с невидимым символом BOM в начале — убираем его.
  cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^﻿/, ''));
} catch (e) {
  console.error('config.json сломан, не могу его прочитать:', e.message);
  console.error('Проверь, что каждое значение в кавычках, а между строками стоят запятые, как в config.example.json.');
  process.exit(1);
}
const clean = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^Bot\s+/i, '').replace(/\s+/g, '');
cfg.discordToken = clean(cfg.discordToken);
cfg.githubToken = clean(cfg.githubToken);
cfg.guildId = clean(cfg.guildId);
for (const k of ['discordToken', 'githubToken', 'guildId']) {
  if (!cfg[k] || cfg[k].includes('ВСТАВЬ')) {
    console.error(`В config.json не заполнено поле "${k}".`);
    process.exit(1);
  }
}
{
  const t = cfg.discordToken;
  const hint = 'Нужен токен со вкладки Bot (кнопка Reset Token), а не Application ID, Public Key или Client Secret со вкладки General/OAuth2.';
  if (/^\d{17,20}$/.test(t)) { console.error('В discordToken стоит ID (только цифры), а не токен. ' + hint); process.exit(1); }
  if (/^[a-f0-9]{64}$/i.test(t)) { console.error('В discordToken стоит Public Key, а не токен. ' + hint); process.exit(1); }
  if (t.split('.').length !== 3) { console.error(`discordToken не похож на токен бота (у токена три части через точку, а тут ${t.split('.').length}). ` + hint); process.exit(1); }
  if (!/^\d{17,20}$/.test(cfg.guildId)) { console.error('guildId должен быть числом, например 1234567890123456789 (ПКМ по серверу → Копировать ID сервера).'); process.exit(1); }
}
const IDS = [cfg.ownerId, ...(cfg.friends || [])].filter(Boolean);
const FILE = 'presence.json';
const MIN_GAP = 15_000;      // не чаще раза в 15 секунд
const HEARTBEAT = 120_000;   // раз в 2 минуты, даже если ничего не поменялось

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences],
});

const log = (...a) => console.log(new Date().toLocaleTimeString('ru-RU'), ...a);
const ms = d => (d ? new Date(d).getTime() : undefined);

function snapshotUser(member) {
  const u = member.user;
  const p = member.presence;
  return {
    discord_user: { id: u.id, username: u.username, global_name: u.globalName || null, avatar: u.avatar || null },
    discord_status: p ? p.status : 'offline',
    activities: (p ? p.activities : []).map(a => ({
      type: a.type,
      name: a.name,
      details: a.details || null,
      state: a.state || null,
      application_id: a.applicationId || null,
      timestamps: a.timestamps ? { start: ms(a.timestamps.start), end: ms(a.timestamps.end) } : null,
      assets: a.assets ? { large_image: a.assets.largeImage || null } : null,
    })),
  };
}

let guild = null;
function buildUsers() {
  const users = {};
  if (!guild) return users;
  for (const id of IDS) {
    const m = guild.members.cache.get(id);
    if (m) users[id] = snapshotUser(m);
  }
  return users;
}

async function gh(method, url, body) {
  const r = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'severeclaw-presence-bot',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function ensureGist(content) {
  if (cfg.gistId) return;
  const g = await gh('POST', '/gists', {
    description: 'SevereClaw: статус для severeclaw.github.io',
    public: true,
    files: { [FILE]: { content } },
  });
  cfg.gistId = g.id;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  log('Создал gist', g.html_url);
}

let lastUsersJson = '';
let lastSent = 0;
let timer = null;

async function publish(force = false, online = true) {
  const users = buildUsers();
  const usersJson = JSON.stringify(users);
  if (!force && usersJson === lastUsersJson) return;
  const content = JSON.stringify({ updated: Date.now(), bot: online, users });
  try {
    if (!cfg.gistId) await ensureGist(content);
    else await gh('PATCH', `/gists/${cfg.gistId}`, { files: { [FILE]: { content } } });
    lastUsersJson = usersJson;
    lastSent = Date.now();
    if (!force) log('Статус обновлён');
  } catch (e) {
    log('Не смог обновить gist:', e.message);
  }
}

function schedule() {
  if (timer) return;
  const wait = Math.max(0, lastSent + MIN_GAP - Date.now());
  timer = setTimeout(() => { timer = null; publish(); }, wait);
}

client.once(Events.ClientReady, async () => {
  guild = client.guilds.cache.get(String(cfg.guildId));
  if (!guild) {
    console.error('Бот не на сервере с guildId из config.json. Пригласи его на сервер.');
    process.exit(1);
  }
  await guild.members.fetch({ user: IDS, withPresences: true }).catch(e => log('fetch members:', e.message));
  const missing = IDS.filter(id => !guild.members.cache.has(id));
  log(`Вошёл как ${client.user.tag}, сервер «${guild.name}». Слежу за ${IDS.length - missing.length} из ${IDS.length}.`);
  if (missing.length) log('Нет на сервере (их статус не будет виден):', missing.join(', '));
  await publish(true);
  setInterval(() => publish(true), HEARTBEAT);
});

client.on(Events.PresenceUpdate, (_old, p) => { if (p.guild && p.guild.id === guild?.id && IDS.includes(p.userId)) schedule(); });
client.on(Events.UserUpdate, (_old, u) => { if (IDS.includes(u.id)) schedule(); });
client.on(Events.GuildMemberAdd, m => { if (IDS.includes(m.id)) schedule(); });
client.on(Events.GuildMemberRemove, m => { if (IDS.includes(m.id)) schedule(); });

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  log('Выключаюсь…');
  await publish(true, false);
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

client.login(cfg.discordToken).catch(e => {
  console.error('Не смог войти в Discord:', e.message);
  if (/disallowed intents/i.test(e.message))
    console.error('Включи в Developer Portal → Bot: PRESENCE INTENT и SERVER MEMBERS INTENT и нажми Save Changes.');
  else if (/invalid token|TokenInvalid|401/i.test(e.code + ' ' + e.message))
    console.error('Discord говорит, что токен неверный. Нажми Reset Token на вкладке Bot, скопируй НОВЫЙ токен целиком и вставь в config.json. Старый после сброса перестаёт работать.');
  else if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(e.code + ' ' + e.message))
    console.error('Нет связи с Discord. Если Discord у тебя работает только через VPN, включи в NekoBox режим TUN: обычный системный прокси Node.js не использует.');
  process.exit(1);
});
