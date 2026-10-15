/**
 * ============================================================
 * TANISHUV CHAT — BACKEND (v2.0)
 * ============================================================
 * - Express server
 * - Fil.one (S3-compatible) xotirada xabarlarni saqlaydi
 * - 24 soatdan eski xabarlar avtomatik tozalanadi
 * - Xabarlarni tahrirlash va o'chirish (15 daqiqa ichida)
 * - Origin/Referer tekshiruvi (boshqa domenda ishlamaydi)
 * - Rate limiting, CORS, Helmet xavfsizlik
 * - Fingerprint va signature tekshiruvi
 * ============================================================
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand
} = require('@aws-sdk/client-s3');

// ============================================================
// 1. SOZLAMALARNI TEKSHIRISH
// ============================================================
const REQUIRED_ENV = [
  'FILONE_ENDPOINT',
  'FILONE_ACCESS_KEY',
  'FILONE_SECRET_KEY',
  'FILONE_BUCKET'
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ XATOLIK: Quyidagi environment variable lar yo\'q:');
  missing.forEach(k => console.error('   - ' + k));
  console.error('\n.env faylini to\'ldiring yoki Render dashboardda qo\'shing.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const BUCKET = process.env.FILONE_BUCKET;
const MESSAGE_TTL_MS = (parseInt(process.env.MESSAGE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 daqiqa
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH) || 350;
const MAX_NAME_LENGTH = parseInt(process.env.MAX_NAME_LENGTH) || 20;
const MAX_MESSAGES_STORED = 1000;

// Frontend URL lar (CORS uchun)
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

console.log('============================================================');
console.log('  TANISHUV CHAT — BACKEND v2.0');
console.log('============================================================');
console.log('  Muhit:', NODE_ENV);
console.log('  Port:', PORT);
console.log('  Bucket:', BUCKET);
console.log('  Endpoint:', process.env.FILONE_ENDPOINT);
console.log('  Region:', process.env.FILONE_REGION || 'eu-west-1');
console.log('  Xabar TTL:', MESSAGE_TTL_MS / 3600000, 'soat');
console.log('  Tahrirlash oynasi:', EDIT_WINDOW_MS / 60000, 'daqiqa');
console.log('  Maks xabar:', MAX_MESSAGE_LENGTH, 'belgi');
console.log('  CORS ruxsat:', ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(', ') : '(hammasi — dev)');
console.log('============================================================\n');

// ============================================================
// 2. FIL.ONE S3 CLIENT
// ============================================================
const s3 = new S3Client({
  endpoint: process.env.FILONE_ENDPOINT,
  region: process.env.FILONE_REGION || 'eu-west-1',
  credentials: {
    accessKeyId: process.env.FILONE_ACCESS_KEY,
    secretAccessKey: process.env.FILONE_SECRET_KEY,
  },
  forcePathStyle: true,
});

const MESSAGES_KEY = 'messages.json';

// ============================================================
// 3. BUCKET TEKSHIRISH
// ============================================================
async function ensureBucketExists() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log('✅ Bucket mavjud:', BUCKET);
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.log('⚠️  Bucket topilmadi, yaratilmoqda...');
      try {
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
        console.log('✅ Bucket yaratildi:', BUCKET);
      } catch (createErr) {
        console.error('❌ Bucket yaratib bo\'lmadi:', createErr.message);
      }
    } else {
      console.error('❌ Bucket tekshirishda xatolik:', err.message);
    }
  }
}

// ============================================================
// 4. XABARLAR BILAN ISHLASH
// ============================================================
async function getMessages() {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: MESSAGES_KEY,
    });
    const response = await s3.send(command);
    const body = await response.Body.transformToString('utf-8');
    const parsed = JSON.parse(body || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return [];
    }
    console.error('getMessages xatolik:', err.message);
    throw err;
  }
}

async function saveMessages(messages) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: MESSAGES_KEY,
    Body: JSON.stringify(messages),
    ContentType: 'application/json; charset=utf-8',
  });
  await s3.send(command);
}

function cleanOldMessages(messages) {
  const now = Date.now();
  return messages.filter(m => (now - m.ts) < MESSAGE_TTL_MS);
}

// ============================================================
// 5. EXPRESS APP
// ============================================================
const app = express();

app.set('trust proxy', 1);

// --- Helmet ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

// --- Compression ---
app.use(compression());

// --- CORS (faqat ruxsat etilgan domenlar) ---
app.use(cors({
  origin: function(origin, callback) {
    // Dev rejimda hammaga ruxsat
    if (!IS_PROD && ALLOWED_ORIGINS.length === 0) {
      return callback(null, true);
    }
    // Origin yo'q (server-to-server) — rad
    if (!origin) {
      if (!IS_PROD) return callback(null, true);
      return callback(new Error('CORS: Origin yo\'q'));
    }
    // Ruxsat etilgan ro'yxatda bor
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    // Dev rejimda localhost va local IP larga ruxsat
    if (!IS_PROD) {
      if (origin.includes('localhost') || 
          origin.includes('127.0.0.1') ||
          /https?:\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(origin)) {
        return callback(null, true);
      }
    }
    console.warn('🚫 CORS rad etdi:', origin);
    return callback(new Error('CORS: ruxsat yo\'q'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
  credentials: false,
  maxAge: 86400,
}));

// --- Body parser ---
app.use(express.json({ limit: '5kb' }));

// ============================================================
// 6. XAVFSIZLIK MIDDLEWARE
// ============================================================

/**
 * Origin/Referer tekshiruvi — boshqa domendan so'rovlarni rad etish
 */
function verifyOrigin(req, res, next) {
  // Health check va static fayllar uchun o'tkazib yuboramiz
  if (req.path === '/health' || !req.path.startsWith('/api/')) {
    return next();
  }

  // Dev rejimda qattiq tekshirmaymiz
  if (!IS_PROD) return next();

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;

  // Agar origin ruxsat etilganlar ro'yxatida bo'lsa
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return next();
  }

  // Referer orqali tekshirish
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const refOrigin = refUrl.origin;
      if (ALLOWED_ORIGINS.includes(refOrigin)) {
        return next();
      }
    } catch (e) {}
  }

  // Host tekshiruvi
  if (host) {
    const hostOrigin = `https://${host}`;
    if (ALLOWED_ORIGINS.includes(hostOrigin)) {
      return next();
    }
  }

  console.warn('🚫 Origin rad etdi:', { origin, referer, host });
  return res.status(403).json({ success: false, error: 'Ruxsat yo\'q' });
}

app.use(verifyOrigin);

// ============================================================
// 7. RATE LIMITING
// ============================================================

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, error: 'Juda ko\'p so\'rov. Birozdan keyin urinib ko\'ring.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, error: 'Juda ko\'p xabar yubordingiz.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// 8. YORDAMCHI FUNKSIYALAR
// ============================================================

function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_NAME_LENGTH) return false;
  return /^[\p{L}\p{N}\s'\-\.]+$/u.test(trimmed);
}

function isValidUserId(userId) {
  if (!userId || typeof userId !== 'string') return false;
  // Faqat "u_..." formatidagi ID
  return /^u_\d+_[a-z0-9]+$/.test(userId);
}

function generateId() {
  return 'm_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

function containsOnlySymbols(text) {
  return /^[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~\s]+$/.test(text);
}

// ============================================================
// 9. API ENDPOINTLAR
// ============================================================

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    version: '2.0',
  });
});

// --- GET /api/messages ---
app.get('/api/messages', apiLimiter, async (req, res) => {
  try {
    const allMessages = await getMessages();
    const freshMessages = cleanOldMessages(allMessages);

    if (freshMessages.length !== allMessages.length) {
      try {
        await saveMessages(freshMessages);
        console.log(`🧹 ${allMessages.length - freshMessages.length} ta eski xabar tozalandi`);
      } catch (saveErr) {
        console.error('Tozalashda xatolik:', saveErr.message);
      }
    }

    const recent = freshMessages.slice(-200);

    res.json({
      success: true,
      count: recent.length,
      messages: recent,
    });
  } catch (err) {
    console.error('GET /api/messages xatolik:', err);
    res.status(500).json({
      success: false,
      error: 'Server xatosi. Keyinroq urinib ko\'ring.',
    });
  }
});

// --- POST /api/messages ---
app.post('/api/messages', sendLimiter, async (req, res) => {
  try {
    const { name, family, userId, text } = req.body || {};

    const cleanName = sanitize(name, MAX_NAME_LENGTH);
    const cleanFamily = sanitize(family, MAX_NAME_LENGTH);
    const cleanUserId = sanitize(userId, 60);
    const cleanText = sanitize(text, MAX_MESSAGE_LENGTH + 1);

    if (!isValidName(cleanName)) {
      return res.status(400).json({
        success: false,
        error: `Ism 2-${MAX_NAME_LENGTH} belgi, faqat harf/raqam`,
      });
    }

    if (!isValidUserId(cleanUserId)) {
      return res.status(400).json({
        success: false,
        error: 'UserId noto\'g\'ri formatda',
      });
    }

    if (!cleanText || cleanText.length === 0) {
      return res.status(400).json({ success: false, error: 'Xabar bo\'sh' });
    }

    if (cleanText.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `Xabar ${MAX_MESSAGE_LENGTH} belgidan oshmasin`,
      });
    }

    if (containsOnlySymbols(cleanText)) {
      return res.status(400).json({
        success: false,
        error: 'Faqat belgilardan iborat xabar yuborib bo\'lmaydi',
      });
    }

    const newMessage = {
      id: generateId(),
      userId: cleanUserId,
      name: cleanName,
      family: cleanFamily,
      text: cleanText,
      ts: Date.now(),
      edited: false,
    };

    const allMessages = await getMessages();
    const freshMessages = cleanOldMessages(allMessages);
    freshMessages.push(newMessage);

    const trimmed = freshMessages.length > MAX_MESSAGES_STORED
      ? freshMessages.slice(-MAX_MESSAGES_STORED)
      : freshMessages;

    await saveMessages(trimmed);

    console.log(`💬 Yangi xabar [${cleanName}]: ${cleanText.slice(0, 40)}...`);

    res.json({ success: true, message: newMessage });
  } catch (err) {
    console.error('POST /api/messages xatolik:', err);
    res.status(500).json({
      success: false,
      error: 'Server xatosi. Keyinroq urinib ko\'ring.',
    });
  }
});

// --- PATCH /api/messages/:id (Tahrirlash) ---
app.patch('/api/messages/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { text, userId } = req.body || {};

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ success: false, error: 'ID kerak' });
    }

    const cleanUserId = sanitize(userId, 60);
    const cleanText = sanitize(text, MAX_MESSAGE_LENGTH + 1);

    if (!isValidUserId(cleanUserId)) {
      return res.status(400).json({ success: false, error: 'UserId noto\'g\'ri' });
    }

    if (!cleanText || cleanText.length === 0) {
      return res.status(400).json({ success: false, error: 'Xabar bo\'sh' });
    }

    if (cleanText.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `Xabar ${MAX_MESSAGE_LENGTH} belgidan oshmasin`,
      });
    }

    if (containsOnlySymbols(cleanText)) {
      return res.status(400).json({
        success: false,
        error: 'Faqat belgilardan iborat xabar',
      });
    }

    const messages = await getMessages();
    const idx = messages.findIndex(m => m.id === id);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Xabar topilmadi' });
    }

    const msg = messages[idx];

    if (msg.userId !== cleanUserId) {
      return res.status(403).json({ success: false, error: 'Ruxsat yo\'q' });
    }

    if (Date.now() - msg.ts > EDIT_WINDOW_MS) {
      return res.status(403).json({
        success: false,
        error: '15 daqiqadan o\'tgan xabarni tahrirlab bo\'lmaydi',
      });
    }

    messages[idx].text = cleanText;
    messages[idx].edited = true;
    messages[idx].editedAt = Date.now();

    await saveMessages(messages);

    console.log(`✏️  Xabar tahrirlandi: ${id}`);

    res.json({ success: true, message: messages[idx] });
  } catch (err) {
    console.error('PATCH /api/messages xatolik:', err);
    res.status(500).json({ success: false, error: 'Server xatosi' });
  }
});

// --- DELETE /api/messages/:id (O'chirish) ---
app.delete('/api/messages/:id', apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body || {};

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ success: false, error: 'ID kerak' });
    }

    const cleanUserId = sanitize(userId, 60);
    if (!isValidUserId(cleanUserId)) {
      return res.status(400).json({ success: false, error: 'UserId noto\'g\'ri' });
    }

    const messages = await getMessages();
    const idx = messages.findIndex(m => m.id === id);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Xabar topilmadi' });
    }

    const msg = messages[idx];

    if (msg.userId !== cleanUserId) {
      return res.status(403).json({ success: false, error: 'Ruxsat yo\'q' });
    }

    if (Date.now() - msg.ts > EDIT_WINDOW_MS) {
      return res.status(403).json({
        success: false,
        error: '15 daqiqadan o\'tgan xabarni o\'chirib bo\'lmaydi',
      });
    }

    messages.splice(idx, 1);
    await saveMessages(messages);

    console.log(`🗑️  Xabar o'chirildi: ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/messages xatolik:', err);
    res.status(500).json({ success: false, error: 'Server xatosi' });
  }
});

// ============================================================
// 10. FRONTEND SERVE
// ============================================================
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.static(PUBLIC_DIR, {
  maxAge: IS_PROD ? '1h' : 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path === '/health') {
    return res.status(404).json({ success: false, error: 'Topilmadi' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ============================================================
// 11. XATOLIKLARNI USHLASH
// ============================================================
app.use((err, req, res, next) => {
  console.error('❌ Global xatolik:', err.message);

  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ success: false, error: 'CORS: ruxsat yo\'q' });
  }

  res.status(500).json({ success: false, error: 'Server xatosi' });
});

// ============================================================
// 12. SERVERNI ISHGA TUSHIRISH
// ============================================================
async function start() {
  await ensureBucketExists();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server ${PORT} portda ishlamoqda`);
    console.log(`   http://localhost:${PORT}\n`);
  });

  // Har 10 daqiqada eski xabarlarni tozalash
  setInterval(async () => {
    try {
      const all = await getMessages();
      const fresh = cleanOldMessages(all);
      if (fresh.length !== all.length) {
        await saveMessages(fresh);
        console.log(`🧹 Avtomatik tozalash: ${all.length - fresh.length} ta o'chirildi`);
      }
    } catch (err) {
      console.error('Avtomatik tozalash xatosi:', err.message);
    }
  }, 10 * 60 * 1000);
}

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

start();