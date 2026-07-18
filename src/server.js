import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { initDb, pool, query } from './lib/db.js';
import { buyTicketsForUser, getGameState, getLobbySnapshot, getReferralStats, getRoomWithSnapshot, getWalletTransactions, listWinners, tickAllRooms } from './lib/game.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PgStore = connectPgSimple(session);
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.use(async (req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.currentUser = null;
  res.locals.flash = req.session.flash;
  delete req.session.flash;

  if (!req.session.userId) return next();
  try {
    const { rows } = await query(`SELECT id, username, email, phone, balance, referral_code, created_at FROM users WHERE id = $1 LIMIT 1`, [req.session.userId]);
    req.user = rows[0] || null;
    res.locals.currentUser = req.user;
    next();
  } catch (error) {
    next(error);
  }
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function makeReferralCode(username) {
  return `${username.replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase()}${Math.floor(1000 + Math.random() * 9000)}`;
}

app.get('/healthz', async (_req, res) => {
  await tickAllRooms().catch(() => {});
  res.json({ ok: true });
});

app.get('/', async (req, res, next) => {
  try {
    const rooms = await getLobbySnapshot();
    if (req.user) return res.redirect('/app');
    res.render('landing', { title: 'BirLoto Pro', rooms });
  } catch (error) {
    next(error);
  }
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/app');
  res.render('login', { title: 'Giriş' });
});

app.post('/login', async (req, res) => {
  const schema = z.object({ login: z.string().min(3), password: z.string().min(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    setFlash(req, 'error', 'Məlumatlar natamamdır.');
    return res.redirect('/login');
  }
  const { login, password } = parsed.data;
  const { rows } = await query(
    `SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`,
    [login]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    setFlash(req, 'error', 'İstifadəçi adı və ya şifrə yanlışdır.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  res.redirect('/app');
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/app');
  res.render('register', { title: 'Qeydiyyat', referralCode: req.query.ref || '' });
});

app.post('/register', async (req, res) => {
  const schema = z.object({
    username: z.string().min(3).max(32),
    email: z.string().email(),
    phone: z.string().optional().or(z.literal('')),
    password: z.string().min(6),
    referralCode: z.string().optional().or(z.literal(''))
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    setFlash(req, 'error', 'Formu düzgün doldurun.');
    return res.redirect('/register');
  }

  const { username, email, phone, password, referralCode } = parsed.data;
  const hash = await bcrypt.hash(password, 10);
  let referredBy = null;
  if (referralCode) {
    const ref = await query(`SELECT id FROM users WHERE referral_code = $1 LIMIT 1`, [referralCode.trim().toUpperCase()]);
    referredBy = ref.rows[0]?.id || null;
  }

  try {
    const { rows } = await query(
      `INSERT INTO users (username, email, phone, password_hash, referral_code, referred_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [username.trim(), email.trim().toLowerCase(), phone?.trim() || null, hash, makeReferralCode(username), referredBy]
    );
    req.session.userId = rows[0].id;
    res.redirect('/app');
  } catch (error) {
    setFlash(req, 'error', 'Bu istifadəçi adı və ya email artıq mövcuddur.');
    res.redirect('/register');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/app', requireAuth, async (req, res, next) => {
  try {
    const rooms = await getLobbySnapshot();
    res.render('dashboard', { title: 'Oyun otaqları', rooms });
  } catch (error) {
    next(error);
  }
});

app.get('/rooms/:slug/join', requireAuth, async (req, res, next) => {
  try {
    const snapshot = await getRoomWithSnapshot(req.params.slug, req.user.id);
    if (!snapshot) return res.status(404).render('error', { title: 'Tapılmadı', message: 'Otaq tapılmadı.' });
    res.render('join', { title: snapshot.room.name, snapshot });
  } catch (error) {
    next(error);
  }
});

app.post('/rooms/:slug/join', requireAuth, async (req, res) => {
  const schema = z.object({ count: z.coerce.number().int().min(1).max(6), autoMark: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    setFlash(req, 'error', 'Bilet sayı yanlışdır.');
    return res.redirect(`/rooms/${req.params.slug}/join`);
  }

  try {
    await buyTicketsForUser({ roomSlug: req.params.slug, user: req.user, count: parsed.data.count, autoMark: parsed.data.autoMark === 'on' });
    setFlash(req, 'success', 'Biletlər uğurla alındı.');
    res.redirect(`/rooms/${req.params.slug}/play`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Bilet almaq mümkün olmadı.');
    res.redirect(`/rooms/${req.params.slug}/join`);
  }
});

app.get('/rooms/:slug/play', requireAuth, async (req, res, next) => {
  try {
    const state = await getGameState(req.params.slug, req.user.id);
    if (!state) return res.status(404).render('error', { title: 'Tapılmadı', message: 'Oyun tapılmadı.' });
    res.render('play', { title: `${state.room.name} - Oyun`, state });
  } catch (error) {
    next(error);
  }
});

app.get('/api/rooms', requireAuth, async (_req, res, next) => {
  try {
    res.json({ ok: true, rooms: await getLobbySnapshot() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/rooms/:slug/state', requireAuth, async (req, res, next) => {
  try {
    const state = await getGameState(req.params.slug, req.user.id);
    if (!state) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, state });
  } catch (error) {
    next(error);
  }
});

app.get('/wallet', requireAuth, async (req, res, next) => {
  try {
    const tx = await getWalletTransactions(req.user.id);
    res.render('wallet', { title: 'Pul kisəsi', tx, demoTopupAmount: Number(process.env.DEMO_TOPUP_AMOUNT || 25) });
  } catch (error) {
    next(error);
  }
});

app.post('/wallet/demo-topup', requireAuth, async (req, res, next) => {
  try {
    const amount = Number(process.env.DEMO_TOPUP_AMOUNT || 25);
    await query(`UPDATE users SET balance = balance + $2, updated_at = NOW() WHERE id = $1`, [req.user.id, amount]);
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, meta)
       VALUES ($1, 'demo_topup', $2, $3::jsonb)`,
      [req.user.id, amount, JSON.stringify({ source: 'manual-demo-topup' })]
    );
    setFlash(req, 'success', `${amount.toFixed(2)}₼ demo balans əlavə olundu.`);
    res.redirect('/wallet');
  } catch (error) {
    next(error);
  }
});

app.get('/winners', requireAuth, async (req, res, next) => {
  try {
    const winners = await listWinners();
    res.render('winners', { title: 'Qaliblər', winners });
  } catch (error) {
    next(error);
  }
});

app.get('/referrals', requireAuth, async (req, res, next) => {
  try {
    const stats = await getReferralStats(req.user.id);
    res.render('referrals', { title: 'Dəvət sistemi', stats, appUrl: process.env.APP_URL || `http://localhost:${port}` });
  } catch (error) {
    next(error);
  }
});

app.get('/profile', requireAuth, async (req, res) => {
  res.render('profile', { title: 'Profil' });
});

app.use((req, res) => {
  res.status(404).render('error', { title: '404', message: 'Səhifə tapılmadı.' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).render('error', { title: 'Xəta', message: error.message || 'Server xətası baş verdi.' });
});

async function ensureDemoUser() {
  const { rows } = await query(`SELECT id FROM users WHERE username = 'demo' LIMIT 1`);
  if (rows[0]) return;
  const hash = await bcrypt.hash('Baku2020_', 10);
  await query(
    `INSERT INTO users (username, email, password_hash, referral_code, balance)
     VALUES ('demo', 'demo@birloto.local', $1, 'DEMO2026', 250)
     ON CONFLICT DO NOTHING`,
    [hash]
  );
}

async function bootstrap() {
  if (process.env.AUTO_MIGRATE !== 'false') await initDb();
  await ensureDemoUser();
  await tickAllRooms().catch((err) => console.error('tick bootstrap failed', err.message));
  app.listen(port, () => console.log(`BirLoto Pro running on :${port}`));
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
