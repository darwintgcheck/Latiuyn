import pg from 'pg';
import { newDb } from 'pg-mem';
import { randomUUID } from 'crypto';

const { Pool } = pg;
export const runtimeMode = process.env.DATABASE_URL ? 'postgres' : 'memory';

function createPool() {
  if (runtimeMode === 'postgres') {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('render.com') || process.env.PGSSLMODE === 'require'
        ? { rejectUnauthorized: false }
        : false
    });
  }

  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => randomUUID(),
    impure: true
  });
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

export const pool = createPool();

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  balance NUMERIC(12,2) NOT NULL DEFAULT 50,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT '#7c3aed',
  ticket_price NUMERIC(10,2) NOT NULL,
  prize_multiplier NUMERIC(10,2) NOT NULL DEFAULT 2,
  win_type TEXT NOT NULL DEFAULT 'full',
  max_tickets INTEGER NOT NULL DEFAULT 6,
  countdown_seconds INTEGER NOT NULL DEFAULT 30,
  draw_interval_seconds INTEGER NOT NULL DEFAULT 4,
  bot_target_min INTEGER NOT NULL DEFAULT 4,
  bot_target_max INTEGER NOT NULL DEFAULT 10,
  jackpot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  jackpot_seed NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'waiting',
  countdown_started_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  pot_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  jackpot_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  draw_order INTEGER[] NOT NULL DEFAULT '{}',
  drawn_numbers INTEGER[] NOT NULL DEFAULT '{}',
  winner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  winner_ticket_id UUID,
  winner_name TEXT,
  winner_prize NUMERIC(12,2),
  winning_numbers INTEGER[] NOT NULL DEFAULT '{}',
  jackpot_winner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  jackpot_winner_name TEXT,
  jackpot_prize NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rounds_room_created ON rounds(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  card JSONB NOT NULL,
  auto_mark BOOLEAN NOT NULL DEFAULT TRUE,
  marked_numbers INTEGER[] NOT NULL DEFAULT '{}',
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_round_user ON tickets(round_id, user_id);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_transaction_id UUID REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  reward_amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const seedRooms = [
  ['bronze-020', 'Neva Classic 0.20₼', '#34d399', 0.20, 4.0, 'full', 6, 28, 4, 4, 10, false, 0, 1],
  ['silver-050', 'Moscow Silver 0.50₼', '#f59e0b', 0.50, 2.4, 'one_line', 6, 28, 4, 4, 10, false, 0, 2],
  ['gold-100', 'Siberia Gold 1.00₼', '#38bdf8', 1.00, 2.8, 'full', 6, 24, 4, 5, 12, false, 0, 3],
  ['platinum-500', 'Imperial Platinum 5.00₼', '#a78bfa', 5.00, 2.1, 'full', 4, 20, 3, 4, 8, false, 0, 4],
  ['jackpot-1000', 'Red Star Jackpot 10.00₼', '#f472b6', 10.00, 1.9, 'full', 4, 18, 3, 4, 8, true, 150, 5]
];

export async function initDb() {
  await pool.query(schema);

  for (const room of seedRooms) {
    await pool.query(
      `INSERT INTO rooms
        (slug, name, theme, ticket_price, prize_multiplier, win_type, max_tickets, countdown_seconds, draw_interval_seconds, bot_target_min, bot_target_max, jackpot_enabled, jackpot_seed, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         theme = EXCLUDED.theme,
         ticket_price = EXCLUDED.ticket_price,
         prize_multiplier = EXCLUDED.prize_multiplier,
         win_type = EXCLUDED.win_type,
         max_tickets = EXCLUDED.max_tickets,
         countdown_seconds = EXCLUDED.countdown_seconds,
         draw_interval_seconds = EXCLUDED.draw_interval_seconds,
         bot_target_min = EXCLUDED.bot_target_min,
         bot_target_max = EXCLUDED.bot_target_max,
         jackpot_enabled = EXCLUDED.jackpot_enabled,
         jackpot_seed = EXCLUDED.jackpot_seed,
         sort_order = EXCLUDED.sort_order`,
      room
    );
  }
}

export async function query(text, params = []) {
  return pool.query(text, params);
}
