/**
 * ገበሬ Airdrop - Server v5.1
 * No auto-earn · Mobile-first · Telegram Bot
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'states.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ANNOUNCEMENT_FILE = path.join(DATA_DIR, 'announcement.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'gebere2024';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(ROOT));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let bot = null;
if (BOT_TOKEN) {
    try {
        bot = new TelegramBot(BOT_TOKEN, { polling: false });
        console.log('✅ Bot initialized');
    } catch (e) { console.error('Bot error:', e.message); }
}

const readJSON = (f, d = {}) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const writeJSON = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch {} };
const getIP = (r) => (r.headers['x-forwarded-for'] || '').split(',')[0].trim() || r.headers['x-real-ip'] || r.ip || 'unknown';

const getConfig = () => readJSON(CONFIG_FILE, { airdropEnded: false, tokenRate: 0.1, birrPerToken: 10 });
const saveConfig = (c) => writeJSON(CONFIG_FILE, c);
const getAnnouncement = () => readJSON(ANNOUNCEMENT_FILE, { message: '', active: false });

function getDefaultState(userId, userName) {
    return {
        userId, userName: userName || 'Farmer', avatar: '', coins: 100,
        wheat: 0, land: 0, seedLevel: 0, irrigationLevel: 0,
        sheep: 0, goat: 0, cow: 0, hen: 0,
        pendingCoins: 0, lastClaimTime: Date.now(), claimCooldown: 14400000,
        totalHarvests: 0, totalSold: 0, totalRevenue: 0, startTime: Date.now(),
        crops: [],
        upgrades: { multiplier: 0, coinBoost: 0 },
        telebirr: { account: '', name: '', submitted: false },
        claimed: { tokens: 0, birr: 0, at: 0, paid: false }
    };
}

const readStates = () => readJSON(STATE_FILE, {});
const writeStates = (s) => writeJSON(STATE_FILE, s);
const readUsers = () => readJSON(USERS_FILE, {});
const writeUsers = (u) => writeJSON(USERS_FILE, u);

function getUserState(userId) {
    const states = readStates();
    if (states[userId]) return states[userId];
    const ns = getDefaultState(userId);
    states[userId] = ns;
    writeStates(states);
    return ns;
}
function saveUserState(userId, state) {
    const states = readStates();
    states[userId] = state;
    writeStates(states);
    return state;
}

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization || '';
    try {
        const [u, p] = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().split(':');
        if (u === ADMIN_USER && p === ADMIN_PASS) return next();
    } catch {}
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).json({ error: 'Unauthorized' });
}

// ===== TELEGRAM AUTH =====
app.post('/api/auth/telegram', (req, res) => {
    try {
        const { tgUser, deviceId } = req.body;
        if (!tgUser || !tgUser.id) return res.status(400).json({ error: 'Telegram user required' });

        const telegramId = String(tgUser.id);
        const userId = 'tg_' + telegramId;
        const ip = getIP(req);
        const users = readUsers();

        const ipOwner = Object.entries(users).find(([id, d]) => d.ip === ip && id !== userId);
        if (ipOwner) return res.json({ verified: false, reason: 'ip', message: 'Multiple accounts from this IP.' });

        if (deviceId) {
            const devOwner = Object.entries(users).find(([id, d]) => d.deviceId === deviceId && id !== userId);
            if (devOwner) return res.json({ verified: false, reason: 'device', message: 'Device linked to another account.' });
        }

        if (!users[userId]) {
            users[userId] = {
                telegramId, username: tgUser.username || '',
                firstName: tgUser.first_name || 'Farmer',
                photoUrl: tgUser.photo_url || '',
                deviceId: deviceId || null, ip,
                createdAt: Date.now(), lastSeen: Date.now()
            };
        } else {
            users[userId].deviceId = deviceId || users[userId].deviceId;
            users[userId].ip = ip;
            users[userId].lastSeen = Date.now();
            users[userId].photoUrl = tgUser.photo_url || users[userId].photoUrl;
        }
        writeUsers(users);

        const state = getUserState(userId);
        state.userName = tgUser.first_name
            ? (tgUser.first_name + (tgUser.last_name ? ' ' + tgUser.last_name : ''))
            : (tgUser.username || 'Farmer');
        state.avatar = tgUser.photo_url || '';
        saveUserState(userId, state);

        res.json({ verified: true, userId, telegramId, userName: state.userName, avatar: state.avatar, state });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

// ===== PLAYER API =====
app.get('/api/state/:userId', (req, res) => {
    try { res.json({ success: true, data: getUserState(req.params.userId) }); }
    catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/state/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const { state } = req.body;
        if (!state) return res.status(400).json({ error: 'state required' });
        const existing = getUserState(userId);
        const merged = { ...existing, ...state, userId };
        saveUserState(userId, merged);
        res.json({ success: true, data: merged });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// TICK - animal production only, NO auto-earn
app.post('/api/state/:userId/tick', (req, res) => {
    try {
        const { userId } = req.params;
        const { elapsedSeconds } = req.body;
        const cfg = getConfig();
        if (cfg.airdropEnded) return res.status(400).json({ error: 'Airdrop ended' });
        if (!elapsedSeconds || elapsedSeconds <= 0 || elapsedSeconds > 3) {
            return res.status(400).json({ error: 'Invalid elapsed' });
        }

        const state = getUserState(userId);

        // Only animal production, no autoFarmer
        let rate = (state.sheep || 0) * 0.03
                 + (state.goat || 0) * 0.05
                 + (state.cow || 0) * 0.12
                 + (state.hen || 0) * 0.02;

        // coinBoost multiplies animal production
        rate *= 1 + (state.upgrades?.coinBoost || 0) * 0.05;

        const earned = rate * elapsedSeconds;
        state.pendingCoins = (state.pendingCoins || 0) + earned;
        saveUserState(userId, state);
        res.json({ success: true, pendingCoins: state.pendingCoins, earned, rate });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// CLAIM
app.post('/api/state/:userId/claim', (req, res) => {
    try {
        const { userId } = req.params;
        const { claimCooldown } = req.body;
        const state = getUserState(userId);
        const cfg = getConfig();
        if (cfg.airdropEnded) return res.status(400).json({ error: 'Airdrop ended' });

        const now = Date.now();
        const elapsed = now - state.lastClaimTime;
        const cooldown = claimCooldown || state.claimCooldown || 14400000;
        const windowMs = 86400000;

        if (elapsed < cooldown) return res.status(400).json({ error: 'Cooldown not ready' });
        if (elapsed >= windowMs) {
            state.pendingCoins = 0;
            state.lastClaimTime = now;
            saveUserState(userId, state);
            return res.status(400).json({ error: 'Window expired' });
        }
        const amount = state.pendingCoins || 0;
        if (amount <= 0) return res.status(400).json({ error: 'Nothing to claim' });

        const multiplier = 1 + (state.upgrades?.multiplier || 0) * 0.1;
        const finalAmount = amount * multiplier;

        state.coins = (state.coins || 0) + finalAmount;
        state.pendingCoins = 0;
        state.lastClaimTime = now;
        saveUserState(userId, state);
        res.json({ success: true, claimed: finalAmount, newBalance: state.coins });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// LEADERBOARD
app.get('/api/leaderboard', (req, res) => {
    try {
        const states = readStates();
        const list = Object.entries(states).map(([id, d]) => ({
            userId: id, userName: d.userName || 'Farmer',
            coins: Math.floor(d.coins || 0),
            animals: (d.sheep || 0) + (d.goat || 0) + (d.cow || 0) + (d.hen || 0)
        }));
        list.sort((a, b) => b.coins - a.coins);
        res.json({ success: true, data: list.slice(0, 100) });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/announcement', (req, res) => res.json({ success: true, data: getAnnouncement() }));
app.get('/api/config/public', (req, res) => {
    const cfg = getConfig();
    res.json({ success: true, data: { airdropEnded: cfg.airdropEnded, tokenRate: cfg.tokenRate, birrPerToken: cfg.birrPerToken } });
});

// UPGRADES (only multiplier + coinBoost)
app.post('/api/state/:userId/upgrade', (req, res) => {
    try {
        const { userId } = req.params;
        const { type } = req.body;
        const cfg = getConfig();
        if (cfg.airdropEnded) return res.status(400).json({ error: 'Airdrop ended' });

        const UPGRADES = {
            multiplier: { baseCost: 100, maxLevel: 20 },
            coinBoost: { baseCost: 300, maxLevel: 20 }
        };
        const info = UPGRADES[type];
        if (!info) return res.status(400).json({ error: 'Invalid upgrade' });

        const state = getUserState(userId);
        if (!state.upgrades) state.upgrades = { multiplier: 0, coinBoost: 0 };
        const level = state.upgrades[type] || 0;
        if (level >= info.maxLevel) return res.status(400).json({ error: 'Max level' });

        const cost = Math.floor(info.baseCost * Math.pow(1.5, level));
        if ((state.coins || 0) < cost) return res.status(400).json({ error: 'Not enough coins', cost });

        state.coins -= cost;
        state.upgrades[type] = level + 1;
        saveUserState(userId, state);
        res.json({ success: true, data: state, newLevel: level + 1 });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// BUY ANIMALS
app.post('/api/state/:userId/buy-animal', (req, res) => {
    try {
        const { userId } = req.params;
        const { type } = req.body;
        const cfg = getConfig();
        if (cfg.airdropEnded) return res.status(400).json({ error: 'Airdrop ended' });

        const ANIMALS = {
            sheep: { baseCost: 30, multi: 8 },
            goat: { baseCost: 45, multi: 10 },
            cow: { baseCost: 80, multi: 15 },
            hen: { baseCost: 25, multi: 6 }
        };
        const a = ANIMALS[type];
        if (!a) return res.status(400).json({ error: 'Invalid animal' });

        const state = getUserState(userId);
        const count = state[type] || 0;
        const cost = Math.floor(a.baseCost + count * a.multi);
        if ((state.coins || 0) < cost) return res.status(400).json({ error: 'Not enough coins', cost });

        state.coins -= cost;
        state[type] = count + 1;
        saveUserState(userId, state);
        res.json({ success: true, data: state });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/state/:userId/buy-land', (req, res) => {
    try {
        const { userId } = req.params;
        const state = getUserState(userId);
        const cost = Math.floor(50 + (state.land || 0) * 30);
        if ((state.coins || 0) < cost) return res.status(400).json({ error: 'Not enough coins', cost });
        if ((state.land || 0) >= 10) return res.status(400).json({ error: 'Max land' });

        state.coins -= cost;
        state.land = (state.land || 0) + 1;
        while ((state.crops || []).length < state.land) state.crops.push({ progress: 0, ready: false, growing: true });
        saveUserState(userId, state);
        res.json({ success: true, data: state });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/state/:userId/buy-seed', (req, res) => {
    try {
        const { userId } = req.params;
        const state = getUserState(userId);
        const cost = Math.floor(20 + (state.seedLevel || 0) * 12);
        if ((state.coins || 0) < cost) return res.status(400).json({ error: 'Not enough coins', cost });
        state.coins -= cost;
        state.seedLevel = (state.seedLevel || 0) + 1;
        saveUserState(userId, state);
        res.json({ success: true, data: state });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/state/:userId/buy-irrigation', (req, res) => {
    try {
        const { userId } = req.params;
        const state = getUserState(userId);
        const cost = Math.floor(60 + (state.irrigationLevel || 0) * 45);
        if ((state.coins || 0) < cost) return res.status(400).json({ error: 'Not enough coins', cost });
        state.coins -= cost;
        state.irrigationLevel = (state.irrigationLevel || 0) + 1;
        saveUserState(userId, state);
        res.json({ success: true, data: state });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// TELEBIRR
app.post('/api/state/:userId/telebirr', (req, res) => {
    try {
        const { account, name } = req.body;
        if (!account || !name) return res.status(400).json({ error: 'Account and name required' });
        const state = getUserState(req.params.userId);
        if (!state.claimed || !state.claimed.tokens) return res.status(400).json({ error: 'No claim' });
        state.telebirr = { account, name, submitted: true, submittedAt: Date.now() };
        saveUserState(req.params.userId, state);
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ===== ADMIN =====
app.get('/api/admin/users', requireAdmin, (req, res) => {
    const states = readStates();
    const users = readUsers();
    const list = Object.entries(states).map(([id, s]) => ({
        userId: id, userName: s.userName || 'Farmer',
        coins: Math.floor(s.coins || 0),
        animals: (s.sheep || 0) + (s.goat || 0) + (s.cow || 0) + (s.hen || 0),
        telebirr: s.telebirr || {},
        claimed: s.claimed || {},
        telegram: users[id] || {}
    }));
    list.sort((a, b) => b.coins - a.coins);
    res.json({ success: true, data: list });
});

app.post('/api/admin/end-airdrop', requireAdmin, (req, res) => {
    const cfg = getConfig();
    cfg.airdropEnded = true;
    saveConfig(cfg);
    res.json({ success: true });
});

app.post('/api/admin/resume-airdrop', requireAdmin, (req, res) => {
    const cfg = getConfig();
    cfg.airdropEnded = false;
    saveConfig(cfg);
    res.json({ success: true });
});

app.post('/api/admin/set-rates', requireAdmin, (req, res) => {
    const { tokenRate, birrPerToken } = req.body;
    const cfg = getConfig();
    if (tokenRate != null) cfg.tokenRate = parseFloat(tokenRate);
    if (birrPerToken != null) cfg.birrPerToken = parseFloat(birrPerToken);
    saveConfig(cfg);
    res.json({ success: true, data: cfg });
});

app.post('/api/admin/announcement', requireAdmin, async (req, res) => {
    const { message, active } = req.body;
    const ann = { message: message || '', active: active !== false, updatedAt: Date.now() };
    writeJSON(ANNOUNCEMENT_FILE, ann);

    let sent = 0;
    if (bot && active && message) {
        const users = readUsers();
        for (const u of Object.values(users)) {
            if (u.telegramId) {
                try {
                    await bot.sendMessage(u.telegramId, `📢 ${message}`, { parse_mode: 'Markdown' });
                    sent++;
                } catch {}
            }
        }
    }
    res.json({ success: true, data: ann, broadcastSent: sent });
});

app.post('/api/admin/mark-paid/:userId', requireAdmin, (req, res) => {
    const state = getUserState(req.params.userId);
    if (!state.claimed) state.claimed = {};
    state.claimed.paid = true;
    state.claimed.paidAt = Date.now();
    saveUserState(req.params.userId, state);
    res.json({ success: true });
});

app.post('/api/admin/calculate-claims', requireAdmin, (req, res) => {
    const cfg = getConfig();
    const states = readStates();
    const results = [];
    for (const [id, s] of Object.entries(states)) {
        const coins = s.coins || 0;
        const tokens = coins * (cfg.tokenRate || 0.1);
        const birr = tokens * (cfg.birrPerToken || 10);
        s.claimed = {
            tokens: Math.floor(tokens * 100) / 100,
            birr: Math.floor(birr * 100) / 100,
            at: Date.now(),
            paid: false
        };
        states[id] = s;
        results.push({ userId: id, userName: s.userName, coins, tokens: s.claimed.tokens, birr: s.claimed.birr, telebirr: s.telebirr });
    }
    writeStates(states);
    res.json({ success: true, count: results.length, data: results });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
    const cfg = getConfig();
    const states = readStates();
    const ann = getAnnouncement();
    let totalCoins = 0, totalTokens = 0, totalBirr = 0, claimedUsers = 0, paidUsers = 0;
    for (const s of Object.values(states)) {
        totalCoins += s.coins || 0;
        if (s.claimed?.tokens) {
            totalTokens += s.claimed.tokens;
            totalBirr += s.claimed.birr;
            claimedUsers++;
            if (s.claimed.paid) paidUsers++;
        }
    }
    res.json({
        success: true,
        data: {
            totalUsers: Object.keys(states).length,
            totalCoins, totalTokens, totalBirr, claimedUsers, paidUsers,
            airdropEnded: cfg.airdropEnded,
            tokenRate: cfg.tokenRate, birrPerToken: cfg.birrPerToken,
            announcement: ann, botOnline: !!bot
        }
    });
});

// ===== STATIC =====
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(ROOT, req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return res.sendFile(filePath);
    const idx = path.join(ROOT, 'index.html');
    if (fs.existsSync(idx)) return res.sendFile(idx);
    res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
    console.log('============================================');
    console.log('🌾 ገበሬ Airdrop Server v5.1');
    console.log('⚡ No auto-earn · Mobile-first');
    console.log('============================================');
    console.log(`🚀 Port: ${PORT}`);
    console.log(`🔑 Admin: ${ADMIN_USER}`);
    console.log(`🤖 Bot: ${bot ? 'ONLINE' : 'OFFLINE'}`);
    console.log('============================================');
});

process.on('SIGINT', () => process.exit(0));
