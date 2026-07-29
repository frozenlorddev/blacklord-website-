// ============================================================
//   BLACKLORD TECH PAYMENT SYSTEM – Full Backend
//   ============================================================
'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-me';
const PORT = process.env.PORT || 3002;

// Paystack
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY;

// Pterodactyl
const PANEL_DOMAIN = process.env.PANEL_DOMAIN;
const PANEL_APIKEY = process.env.PANEL_APIKEY;
const PANEL_EGG   = parseInt(process.env.PANEL_EGG) || 15;
const PANEL_NEST  = parseInt(process.env.PANEL_NEST) || 5;
const PANEL_LOC   = parseInt(process.env.PANEL_LOC) || 1;

// DigitalOcean (optional – comment out if not used)
// const DO_API_KEY = process.env.DO_API_KEY;

// ─── DATABASE ──────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'database.json');

function ensureDir() {
    // No folders – database.json will be in the same directory
}
ensureDir();

let db = {
    users: {},
    prices: {
        panel: { '1gb': 1000, '2gb': 2000, '3gb': 3000, '4gb': 4000, 'unlimited': 8000 },
        vps: { '1gb': 5000, '2gb': 10000, '4gb': 20000, '8gb': 40000 },
        currency: 'KES',
    },
    fileStore: [],
};

function loadDb() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
            db = { ...db, ...data };
        }
    } catch (e) { console.error('Failed to load database:', e.message); }
}
function saveDb() {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch (e) { console.error('Failed to save:', e.message); }
}
loadDb();

// ─── HELPERS ────────────────────────────────────────────────
function generateReferralCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generatePassword(username) {
    const first = username.charAt(0).toUpperCase();
    const rest = username.slice(1).toLowerCase();
    const digits = String(Math.floor(Math.random() * 90 + 10));
    return first + rest + digits + '!';
}

function getRam(ramKey) {
    const map = { '1gb': 1024, '2gb': 2048, '3gb': 3072, '4gb': 4096, 'unlimited': 0 };
    return map[ramKey] || 2048;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = auth.slice(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ─── PAYSTACK HELPERS ──────────────────────────────────────
async function initPaystackPayment(amount, email, reference, metadata = {}) {
    try {
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                amount: amount * 100,
                email: email || 'user@example.com',
                reference: reference || `PAY-${Date.now()}`,
                metadata: metadata,
                callback_url: process.env.PAYSTACK_CALLBACK_URL || '',
            },
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
                timeout: 10000,
            }
        );
        return response.data;
    } catch (err) {
        console.error('Paystack init error:', err.response?.data || err.message);
        return null;
    }
}

async function verifyPaystackPayment(reference) {
    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
                timeout: 10000,
            }
        );
        return response.data;
    } catch (err) {
        console.error('Paystack verify error:', err.response?.data || err.message);
        return null;
    }
}

// ─── PTERODACTYL PANEL CREATION ──────────────────────────────
async function createPterodactylPanel(username, ramMB, diskMB, cpuPercent, isAdmin = false) {
    try {
        // 1. Create user
        const userRes = await axios.post(
            `${PANEL_DOMAIN}/api/application/users`,
            {
                email: `${username}@gmail.com`,
                username: username,
                first_name: username,
                last_name: isAdmin ? 'Admin' : 'Panel',
                root_admin: isAdmin,
                language: 'en',
                password: generatePassword(username),
            },
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' },
                timeout: 15000,
            }
        );
        const userId = userRes.data.attributes.id;

        // 2. Get allocation (port)
        const allocRes = await axios.get(
            `${PANEL_DOMAIN}/api/application/nodes/${PANEL_LOC}/allocations`,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}` },
                timeout: 15000,
            }
        );
        const alloc = allocRes.data.data.find(a => a.attributes.assigned === false);
        if (!alloc) throw new Error('No available port');
        const allocId = alloc.attributes.id;

        // 3. Get egg details
        const eggRes = await axios.get(
            `${PANEL_DOMAIN}/api/application/nests/${PANEL_NEST}/eggs/${PANEL_EGG}?include=variables`,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}` },
                timeout: 15000,
            }
        );
        const eggDetails = eggRes.data.attributes;

        // 4. Build environment variables
        const environment = {};
        if (eggDetails.relationships && eggDetails.relationships.variables && eggDetails.relationships.variables.data) {
            for (const varData of eggDetails.relationships.variables.data) {
                const varAttr = varData.attributes || varData;
                const key = varAttr.env_variable;
                if (key) {
                    environment[key] = varAttr.default_value || '';
                }
            }
        }
        environment.NODE_VERSION = '18';
        environment.INST = 'npm';
        environment.CMD_RUN = 'npm start';

        // 5. Create server
        const serverData = {
            name: `${username}-${isAdmin ? 'admin' : 'panel'}-${Date.now().toString().slice(-4)}`,
            user: userId,
            egg: PANEL_EGG,
            docker_image: eggDetails.docker_image || 'ghcr.io/parkervcp/yolks:nodejs_18',
            startup: eggDetails.startup || 'npm start',
            environment: environment,
            skip_scripts: false,
            limits: { memory: ramMB, swap: 0, disk: diskMB, io: 500, cpu: cpuPercent },
            feature_limits: { databases: 1, backups: 1 },
            allocation: { default: allocId },
            deployment: { locations: [PANEL_LOC] },
            start_on_completion: true,
        };

        const srvRes = await axios.post(
            `${PANEL_DOMAIN}/api/application/servers`,
            serverData,
            {
                headers: { Authorization: `Bearer ${PANEL_APIKEY}`, 'Content-Type': 'application/json' },
                timeout: 30000,
            }
        );

        return {
            username: username,
            password: generatePassword(username),
            domain: PANEL_DOMAIN,
            serverId: srvRes.data.attributes.id,
        };
    } catch (e) {
        const errorMsg = e.response?.data?.errors?.[0]?.detail || e.message;
        throw new Error(`Panel creation failed: ${errorMsg}`);
    }
}

// ─── DIGITALOCEAN VPS CREATION (placeholder – you can implement) ──
async function createVPS(username, ram) {
    // Replace with real DigitalOcean API call if you have DO_API_KEY
    // For now, return simulated credentials
    return {
        ip: '192.168.1.100',
        password: generatePassword(username),
        dropletId: '12345678',
    };
}

// ─── PENDING PAYMENTS ──────────────────────────────────────
const pendingPayments = new Map();

// ─── API ENDPOINTS ──────────────────────────────────────────

// 1. Signup
app.post('/api/signup', async (req, res) => {
    const { firstName, lastName, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const existing = Object.values(db.users).find(u => u.email === email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const userId = `user_${Date.now()}`;
    db.users[userId] = {
        email,
        firstName,
        lastName,
        passwordHash: hashed,
        sdBalance: 0,
        panels: [],
        vps: [],
        referralsCount: 0,
        referralCode: generateReferralCode(),
        registeredAt: new Date().toISOString(),
    };
    saveDb();
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email, firstName, lastName, sdBalance: 0, totalPanels: 0 } });
});

// 2. Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const userEntry = Object.entries(db.users).find(([id, u]) => u.email === email);
    if (!userEntry) return res.status(401).json({ error: 'Invalid credentials' });
    const userId = userEntry[0];
    const user = userEntry[1];
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        sdBalance: user.sdBalance || 0,
        totalPanels: (user.panels || []).length,
        activePanels: (user.panels || []).filter(p => p.status !== 'suspended').length,
        referralsCount: user.referralsCount || 0,
    }});
});

// 3. Get User Data (Dashboard)
app.get('/api/me', authMiddleware, async (req, res) => {
    const user = db.users[req.userId];
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({
        user: {
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            sdBalance: user.sdBalance || 0,
            totalPanels: (user.panels || []).length,
            activePanels: (user.panels || []).filter(p => p.status !== 'suspended').length,
            orders: (user.panels || []).length + (user.vps || []).length,
            referralsCount: user.referralsCount || 0,
        }
    });
});

// 4. Get Products
app.get('/api/products', (req, res) => {
    const panels = Object.keys(db.prices.panel).map(key => ({
        type: 'panel', id: key,
        name: key.toUpperCase() + ' Panel',
        ram: key === 'unlimited' ? 'Unlimited' : key + 'GB',
        price: db.prices.panel[key],
        currency: db.prices.currency,
    }));
    const vps = Object.keys(db.prices.vps).map(key => ({
        type: 'vps', id: key,
        name: key.toUpperCase() + ' VPS',
        ram: key + 'GB',
        price: db.prices.vps[key],
        currency: db.prices.currency,
    }));
    const files = (db.fileStore || []).map(f => ({
        type: 'file', id: f.fileId,
        name: f.name,
        description: f.description || '',
        price: f.price || 500,
        currency: db.prices.currency || 'KES',
    }));
    res.json({ panels, vps, files });
});

// 5. Top Up SD
app.post('/api/topup', authMiddleware, async (req, res) => {
    const { amountKsh } = req.body;
    if (!amountKsh || amountKsh <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const sdAmount = Math.round(amountKsh / 1.6); // 5 SD = 8 KSH
    if (sdAmount <= 0) return res.status(400).json({ error: 'Amount too small' });

    const reference = `TOPUP-${userId}-${Date.now()}`;
    const email = user.email || 'user@example.com';

    const init = await initPaystackPayment(amountKsh, email, reference, {
        type: 'topup',
        userId: userId,
        sdAmount: sdAmount,
        amountKsh: amountKsh,
    });

    if (!init || !init.status) return res.status(500).json({ error: 'Payment initiation failed' });

    pendingPayments.set(reference, {
        userId: userId,
        type: 'topup',
        sdAmount: sdAmount,
        amountKsh: amountKsh,
        status: 'pending',
    });

    res.json({ reference, authorization_url: init.data.authorization_url });
});

// 6. Verify Payment
app.get('/api/verify-payment', async (req, res) => {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    const verify = await verifyPaystackPayment(reference);
    if (!verify || !verify.status || verify.data.status !== 'success') {
        return res.status(400).json({ error: 'Payment not successful' });
    }

    const metadata = verify.data.metadata || {};
    const pending = pendingPayments.get(reference);

    if (metadata.type === 'topup' || pending?.type === 'topup') {
        const userId = metadata.userId || pending?.userId;
        const sdAmount = parseFloat(metadata.sdAmount || pending?.sdAmount || 0);
        if (userId && sdAmount > 0) {
            const user = db.users[userId];
            if (user) {
                user.sdBalance = (user.sdBalance || 0) + sdAmount;
                saveDb();
                pendingPayments.delete(reference);
                return res.json({
                    success: true,
                    message: `✅ Added ${sdAmount} SD to your balance!`,
                    sdBalance: user.sdBalance,
                });
            }
        }
        pendingPayments.delete(reference);
        return res.json({ success: true, message: 'Top-up processed.' });
    }

    // If it was a product purchase via KSH (if you want that, else ignore)
    pendingPayments.delete(reference);
    res.json({ success: true, message: 'Payment verified.' });
});

// 7. Buy Product with SD
app.post('/api/buy', authMiddleware, async (req, res) => {
    const { productType, productId, username } = req.body;
    const userId = req.userId;
    const user = db.users[userId];
    if (!user) return res.status(401).json({ error: 'User not found' });

    let sdPrice = 0;
    let productDetails = {};
    const sdToKsh = 1.6;

    if (productType === 'panel') {
        const ram = productId;
        const kshPrice = db.prices.panel[ram];
        if (!kshPrice) return res.status(400).json({ error: 'Invalid panel plan' });
        sdPrice = Math.round(kshPrice / sdToKsh);
        productDetails = { ram, username };
    } else if (productType === 'vps') {
        const ram = productId;
        const kshPrice = db.prices.vps[ram];
        if (!kshPrice) return res.status(400).json({ error: 'Invalid VPS plan' });
        sdPrice = Math.round(kshPrice / sdToKsh);
        productDetails = { ram, username };
    } else if (productType === 'file') {
        const file = db.fileStore.find(f => f.fileId === productId);
        if (!file) return res.status(400).json({ error: 'File not found' });
        const kshPrice = file.price || 500;
        sdPrice = Math.round(kshPrice / sdToKsh);
        productDetails = { fileId: productId, fileName: file.name };
    } else {
        return res.status(400).json({ error: 'Invalid product type' });
    }

    if (sdPrice <= 0) return res.status(400).json({ error: 'Price not configured' });

    if ((user.sdBalance || 0) < sdPrice) {
        return res.status(402).json({
            error: 'Insufficient SD balance',
            sdBalance: user.sdBalance || 0,
            sdRequired: sdPrice,
            kshRequired: Math.round(sdPrice * sdToKsh),
        });
    }

    // Deduct SD
    user.sdBalance -= sdPrice;
    saveDb();

    let result = { success: true };

    try {
        if (productType === 'panel') {
            // Create real Pterodactyl panel
            const panel = await createPterodactylPanel(
                username,
                getRam(productDetails.ram),
                1024, // disk in MB – adjust as needed
                40,   // CPU %
                false // isAdmin
            );
            result.panel = panel;
            if (!user.panels) user.panels = [];
            user.panels.push({
                type: 'PANEL',
                username: username,
                ram: productDetails.ram,
                createdAt: new Date().toISOString(),
                credentials: panel,
            });
            saveDb();
        } else if (productType === 'vps') {
            // Create VPS (real or simulated)
            const vps = await createVPS(username, productDetails.ram);
            result.vps = vps;
            if (!user.vps) user.vps = [];
            user.vps.push({
                type: 'VPS',
                username: username,
                ram: productDetails.ram,
                createdAt: new Date().toISOString(),
                credentials: vps,
            });
            saveDb();
        } else if (productType === 'file') {
            const file = db.fileStore.find(f => f.fileId === productDetails.fileId);
            result.file = { name: file?.name || 'File', fileId: productDetails.fileId };
            // No need to save file purchase, but you could log it
        }

        res.json(result);
    } catch (err) {
        // Refund SD on error
        user.sdBalance += sdPrice;
        saveDb();
        res.status(500).json({ error: 'Product creation failed: ' + err.message });
    }
});

// 8. Recent Activity
app.get('/api/activity', authMiddleware, async (req, res) => {
    const user = db.users[req.userId];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const activities = [];
    // Add panel creation activities
    if (user.panels) {
        user.panels.forEach(p => {
            activities.push({
                type: 'panel',
                desc: `Panel Deployed: ${p.username}`,
                amount: -1250, // you could store the price in the panel record
                date: new Date(p.createdAt).toLocaleDateString(),
            });
        });
    }
    // Add VPS activities
    if (user.vps) {
        user.vps.forEach(v => {
            activities.push({
                type: 'vps',
                desc: `VPS Deployed: ${v.username}`,
                amount: -2500,
                date: new Date(v.createdAt).toLocaleDateString(),
            });
        });
    }
    // Add referral bonus
    if (user.referralsCount > 0) {
        activities.push({
            type: 'referral',
            desc: `Referral Bonus (${user.referralsCount} referrals)`,
            amount: user.referralsCount * 5,
            date: new Date().toLocaleDateString(),
        });
    }
    // If empty, return sample data
    if (activities.length === 0) {
        return res.json({ activities: [
            { type: 'panel', desc: 'Panel Deployed: myvps', amount: -1250, date: '17 Jun 2026' },
            { type: 'topup', desc: 'SD Top-up', amount: 50, date: '16 Jun 2026' },
            { type: 'referral', desc: 'Referral Bonus', amount: 5, date: '15 Jun 2026' },
        ]});
    }

    // Sort by date descending (most recent first)
    activities.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ activities: activities.slice(0, 10) });
});

// ─── START SERVER ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ API server running on port ${PORT}`);
    console.log(`📍 http://localhost:${PORT}`);
});