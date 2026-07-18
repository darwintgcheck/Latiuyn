import { query, pool } from './db.js';
import { generateTickets, isWinningTicket, numbersMarked, randomDrawOrder } from './tambola.js';
import { v4 as uuidv4 } from 'uuid';

const BOT_NAMES = ['Nigar', 'Sehirli_Xalat', 'Emin_Loto', 'Narmin', 'Ravena', 'Mete', 'Xezer', 'BakuStar', 'Moon7', 'KralBingo', 'Sahil', 'Rufat'];

const toNum = (v) => Number(v || 0);
const toArr = (v) => Array.isArray(v) ? v.map(Number) : [];

function now() {
  return new Date();
}

function secsBetween(a, b) {
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 1000));
}

async function getRooms() {
  const { rows } = await query(`SELECT * FROM rooms WHERE is_active = true ORDER BY sort_order ASC, id ASC`);
  return rows;
}

async function latestRound(client, roomId) {
  const { rows } = await client.query(`SELECT * FROM rounds WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1`, [roomId]);
  return rows[0] || null;
}

async function createRound(client, room) {
  const { rows } = await client.query(
    `INSERT INTO rounds (room_id, status, jackpot_amount, draw_order)
     VALUES ($1, 'waiting', $2, $3)
     RETURNING *`,
    [room.id, room.jackpot_enabled ? toNum(room.jackpot_seed) : 0, randomDrawOrder()]
  );
  return rows[0];
}

async function getOrCreateCurrentRound(client, room) {
  let round = await latestRound(client, room.id);
  if (!round || round.status === 'finished') round = await createRound(client, room);
  return round;
}

async function listTickets(client, roundId) {
  const { rows } = await client.query(`SELECT * FROM tickets WHERE round_id = $1 ORDER BY created_at ASC`, [roundId]);
  return rows.map((row) => ({
    ...row,
    card: row.card,
    marked_numbers: toArr(row.marked_numbers)
  }));
}

async function addBots(client, room, round) {
  const tickets = await listTickets(client, round.id);
  const existingBots = tickets.filter((t) => t.is_bot).length;
  if (existingBots > 0) return;
  const humans = tickets.filter((t) => !t.is_bot).length;
  const target = Math.max(room.bot_target_min, Math.min(room.bot_target_max, humans + Math.floor(Math.random() * 3) + 2));
  const botsToCreate = Math.max(0, target - tickets.length);
  if (!botsToCreate) return;

  const cards = generateTickets(botsToCreate);
  for (let i = 0; i < botsToCreate; i += 1) {
    const name = BOT_NAMES[(Math.floor(Math.random() * BOT_NAMES.length) + i) % BOT_NAMES.length] + (Math.floor(Math.random() * 90) + 10);
    await client.query(
      `INSERT INTO tickets (round_id, room_id, player_name, card, auto_mark, is_bot)
       VALUES ($1,$2,$3,$4,true,true)`,
      [round.id, room.id, name, JSON.stringify(cards[i])]
    );
  }

  const totalCount = tickets.length + botsToCreate;
  const potAmount = totalCount * toNum(room.ticket_price) * toNum(room.prize_multiplier);
  let jackpotAmount = toNum(round.jackpot_amount);
  if (room.jackpot_enabled) {
    jackpotAmount += botsToCreate * toNum(room.ticket_price) * 0.2;
  }
  await client.query(`UPDATE rounds SET pot_amount = $2, jackpot_amount = $3 WHERE id = $1`, [round.id, potAmount, jackpotAmount]);
}

async function finishRound(client, room, round, winnerTicket, drawnNumbers) {
  const prize = Number(toNum(round.pot_amount).toFixed(2));
  const marked = numbersMarked(winnerTicket.card, drawnNumbers);
  const earlyFinish = drawnNumbers.length <= 30;
  let jackpotPrize = null;

  await client.query(
    `UPDATE rounds
     SET status = 'finished', finished_at = NOW(), winner_user_id = $2, winner_ticket_id = $3,
         winner_name = $4, winner_prize = $5, winning_numbers = $6,
         jackpot_winner_user_id = $7, jackpot_winner_name = $8, jackpot_prize = $9,
         drawn_numbers = $10
     WHERE id = $1`,
    [
      round.id,
      winnerTicket.user_id,
      winnerTicket.id,
      winnerTicket.player_name,
      prize,
      marked,
      room.jackpot_enabled && earlyFinish ? winnerTicket.user_id : null,
      room.jackpot_enabled && earlyFinish ? winnerTicket.player_name : null,
      room.jackpot_enabled && earlyFinish ? toNum(round.jackpot_amount) : null,
      drawnNumbers
    ]
  );

  if (winnerTicket.user_id) {
    const totalPrize = prize + (room.jackpot_enabled && earlyFinish ? toNum(round.jackpot_amount) : 0);
    const trxId = uuidv4();
    await client.query(`UPDATE users SET balance = balance + $2, updated_at = NOW() WHERE id = $1`, [winnerTicket.user_id, totalPrize]);
    await client.query(
      `INSERT INTO wallet_transactions (id, user_id, type, amount, meta)
       VALUES ($1,$2,'win',$3,$4::jsonb)`,
      [trxId, winnerTicket.user_id, totalPrize, JSON.stringify({ room: room.slug, roundId: round.id })]
    );
  }

  jackpotPrize = room.jackpot_enabled && earlyFinish ? toNum(round.jackpot_amount) : null;
  return { prize, jackpotPrize };
}

async function tickRoom(client, room) {
  let round = await getOrCreateCurrentRound(client, room);
  const currentTickets = await listTickets(client, round.id);
  const humanCount = currentTickets.filter((t) => !t.is_bot).length;
  const status = round.status;
  const currentTime = now();

  if (status === 'waiting' && humanCount > 0) {
    const startsAt = new Date(currentTime.getTime() + room.countdown_seconds * 1000);
    await client.query(
      `UPDATE rounds SET status = 'starting', countdown_started_at = NOW(), starts_at = $2 WHERE id = $1`,
      [round.id, startsAt]
    );
    round.status = 'starting';
    round.countdown_started_at = currentTime;
    round.starts_at = startsAt;
    await addBots(client, room, round);
    round = (await client.query(`SELECT * FROM rounds WHERE id = $1`, [round.id])).rows[0];
  }

  if (round.status === 'starting' && round.starts_at && currentTime >= new Date(round.starts_at)) {
    await client.query(`UPDATE rounds SET status = 'started', started_at = COALESCE(started_at, NOW()) WHERE id = $1`, [round.id]);
    round.status = 'started';
    round.started_at = currentTime;
  }

  if (round.status === 'started') {
    const startedAt = new Date(round.started_at || currentTime);
    const elapsed = secsBetween(currentTime, startedAt);
    const drawCount = Math.min(90, Math.max(1, Math.floor(elapsed / room.draw_interval_seconds) + 1));
    const drawOrder = toArr(round.draw_order);
    const drawnNumbers = drawOrder.slice(0, drawCount);
    await client.query(`UPDATE rounds SET drawn_numbers = $2 WHERE id = $1`, [round.id, drawnNumbers]);

    const tickets = await listTickets(client, round.id);
    const winnerTicket = tickets.find((ticket) => isWinningTicket(ticket.card, drawnNumbers, room.win_type));
    if (winnerTicket) {
      await finishRound(client, room, round, winnerTicket, drawnNumbers);
    }
  }
}

export async function tickAllRooms() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rooms = await getRooms();
    for (const room of rooms) {
      await tickRoom(client, room);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getLobbySnapshot() {
  await tickAllRooms();
  const rooms = await getRooms();
  const { rows } = await query(
    `SELECT DISTINCT ON (r.room_id)
      r.*, rm.slug, rm.name, rm.theme, rm.ticket_price, rm.prize_multiplier, rm.win_type, rm.max_tickets, rm.countdown_seconds, rm.draw_interval_seconds, rm.jackpot_enabled
     FROM rounds r
     JOIN rooms rm ON rm.id = r.room_id
     ORDER BY r.room_id, r.created_at DESC`
  );

  const nowDate = now();
  return rows.map((row) => {
    let secsLeft = 0;
    if (row.status === 'starting' && row.starts_at) secsLeft = Math.max(0, secsBetween(new Date(row.starts_at), nowDate));
    if (row.status === 'started' && row.started_at) secsLeft = Math.max(0, secsBetween(nowDate, new Date(row.started_at)));
    return {
      roomId: row.room_id,
      slug: row.slug,
      name: row.name,
      theme: row.theme,
      price: toNum(row.ticket_price),
      multiplier: toNum(row.prize_multiplier),
      winType: row.win_type,
      maxTickets: row.max_tickets,
      status: row.status,
      secsLeft,
      pot: toNum(row.pot_amount),
      jackpot: row.jackpot_enabled ? toNum(row.jackpot_amount) : null,
      drawnCount: toArr(row.drawn_numbers).length,
      lastWinner: row.winner_name,
      lastWinnerPrize: toNum(row.winner_prize),
      ticketLabel: `${toNum(row.ticket_price).toFixed(2)}₼`
    };
  });
}

export async function getRoomWithSnapshot(slug, userId) {
  await tickAllRooms();
  const roomResult = await query(`SELECT * FROM rooms WHERE slug = $1 AND is_active = true LIMIT 1`, [slug]);
  const room = roomResult.rows[0];
  if (!room) return null;

  const round = (await query(`SELECT * FROM rounds WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1`, [room.id])).rows[0];
  const tickets = (await query(`SELECT * FROM tickets WHERE round_id = $1 ORDER BY created_at ASC`, [round.id])).rows.map((row) => ({
    ...row,
    card: row.card,
    marked_numbers: toArr(row.marked_numbers)
  }));
  const myTickets = tickets.filter((ticket) => ticket.user_id === userId);
  const nowDate = now();
  let secsLeft = 0;
  if (round.status === 'starting' && round.starts_at) secsLeft = Math.max(0, secsBetween(new Date(round.starts_at), nowDate));
  if (round.status === 'started' && round.started_at) secsLeft = Math.max(0, secsBetween(nowDate, new Date(round.started_at)));

  return {
    room,
    round: {
      ...round,
      pot_amount: toNum(round.pot_amount),
      jackpot_amount: toNum(round.jackpot_amount),
      drawn_numbers: toArr(round.drawn_numbers),
      winning_numbers: toArr(round.winning_numbers),
      secsLeft
    },
    tickets,
    myTickets,
    playerCount: tickets.length,
    botCount: tickets.filter((t) => t.is_bot).length
  };
}

export async function buyTicketsForUser({ roomSlug, user, count, autoMark = true }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const room = (await client.query(`SELECT * FROM rooms WHERE slug = $1 LIMIT 1`, [roomSlug])).rows[0];
    if (!room) throw new Error('Otaq tapılmadı.');

    await tickRoom(client, room);
    let round = await getOrCreateCurrentRound(client, room);
    if (round.status === 'finished') round = await createRound(client, room);
    if (round.status === 'started') throw new Error('Oyun artıq başlayıb, növbəti raundu gözləyin.');

    const existing = (await client.query(`SELECT COUNT(*)::int AS count FROM tickets WHERE round_id = $1 AND user_id = $2`, [round.id, user.id])).rows[0].count;
    if (existing + count > room.max_tickets) throw new Error(`Bir raund üçün maksimum ${room.max_tickets} bilet ala bilərsiniz.`);

    const totalCost = Number((toNum(room.ticket_price) * count).toFixed(2));
    const freshUser = (await client.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [user.id])).rows[0];
    if (toNum(freshUser.balance) < totalCost) throw new Error('Balans kifayət etmir.');

    const cards = generateTickets(count);
    for (const card of cards) {
      await client.query(
        `INSERT INTO tickets (round_id, room_id, user_id, player_name, card, auto_mark, marked_numbers, is_bot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
        [round.id, room.id, user.id, user.username, JSON.stringify(card), autoMark, [], false]
      );
    }

    const newHumanCount = existing + count;
    const prizePot = Number((((await client.query(`SELECT COUNT(*)::int AS c FROM tickets WHERE round_id = $1`, [round.id])).rows[0].c) * toNum(room.ticket_price) * toNum(room.prize_multiplier)).toFixed(2));
    const jackpotBump = room.jackpot_enabled ? Number((count * toNum(room.ticket_price) * 0.2).toFixed(2)) : 0;

    const purchaseTrx = uuidv4();
    await client.query(`UPDATE users SET balance = balance - $2, updated_at = NOW() WHERE id = $1`, [user.id, totalCost]);
    await client.query(
      `INSERT INTO wallet_transactions (id, user_id, type, amount, meta)
       VALUES ($1,$2,'ticket_purchase',$3,$4::jsonb)`,
      [purchaseTrx, user.id, -totalCost, JSON.stringify({ room: room.slug, roundId: round.id, count })]
    );

    if (freshUser.referred_by) {
      const reward = Number((totalCost * 0.05).toFixed(2));
      await client.query(`UPDATE users SET balance = balance + $2, updated_at = NOW() WHERE id = $1`, [freshUser.referred_by, reward]);
      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, meta)
         VALUES ($1,'referral_reward',$2,$3::jsonb)`,
        [freshUser.referred_by, reward, JSON.stringify({ fromUser: user.username, purchase: totalCost })]
      );
      await client.query(
        `INSERT INTO referral_rewards (referrer_user_id, referred_user_id, source_transaction_id, reward_amount)
         VALUES ($1,$2,$3,$4)`,
        [freshUser.referred_by, user.id, purchaseTrx, reward]
      );
    }

    await client.query(
      `UPDATE rounds SET pot_amount = $2, jackpot_amount = COALESCE(jackpot_amount,0) + $3 WHERE id = $1`,
      [round.id, prizePot, jackpotBump]
    );

    await tickRoom(client, room);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getGameState(roomSlug, userId) {
  const snapshot = await getRoomWithSnapshot(roomSlug, userId);
  if (!snapshot) return null;
  const { room, round, tickets, myTickets } = snapshot;
  const status = round.status;
  const winner = status === 'finished' && round.winner_name
    ? {
        name: round.winner_name,
        prize: toNum(round.winner_prize),
        youWon: myTickets.some((t) => t.id === round.winner_ticket_id)
      }
    : null;

  return {
    room: {
      slug: room.slug,
      name: room.name,
      theme: room.theme,
      ticketPrice: toNum(room.ticket_price),
      multiplier: toNum(room.prize_multiplier),
      maxTickets: room.max_tickets,
      winType: room.win_type,
      jackpotEnabled: room.jackpot_enabled
    },
    round: {
      id: round.id,
      status,
      potAmount: toNum(round.pot_amount),
      jackpotAmount: room.jackpot_enabled ? toNum(round.jackpot_amount) : null,
      secsLeft: round.secsLeft,
      drawnNumbers: round.drawn_numbers,
      winningNumbers: round.winning_numbers,
      playerCount: tickets.length,
      myTickets: myTickets.map((ticket) => ({
        id: ticket.id,
        card: ticket.card,
        markedNumbers: ticket.auto_mark ? numbersMarked(ticket.card, round.drawn_numbers) : ticket.marked_numbers
      })),
      winner,
      jackpot: status === 'finished' && round.jackpot_prize
        ? {
            name: round.jackpot_winner_name,
            prize: toNum(round.jackpot_prize),
            youWon: myTickets.some((t) => t.user_id && t.user_id === round.jackpot_winner_user_id)
          }
        : null
    }
  };
}

export async function listWinners(limit = 20) {
  const { rows } = await query(
    `SELECT r.slug, r.name AS room_name, rd.winner_name, rd.winner_prize, rd.jackpot_winner_name, rd.jackpot_prize,
            rd.winning_numbers, rd.finished_at
     FROM rounds rd
     JOIN rooms r ON r.id = rd.room_id
     WHERE rd.status = 'finished' AND rd.winner_name IS NOT NULL
     ORDER BY rd.finished_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );

  return rows.map((row) => ({
    ...row,
    winner_prize: toNum(row.winner_prize),
    jackpot_prize: toNum(row.jackpot_prize),
    winning_numbers: toArr(row.winning_numbers)
  }));
}

export async function getReferralStats(userId) {
  const codeRes = await query(`SELECT referral_code FROM users WHERE id = $1`, [userId]);
  const code = codeRes.rows[0]?.referral_code;
  const referred = await query(`SELECT username, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC`, [userId]);
  const rewards = await query(`SELECT COALESCE(SUM(reward_amount),0) AS total FROM referral_rewards WHERE referrer_user_id = $1`, [userId]);
  return {
    code,
    referredUsers: referred.rows,
    totalRewards: toNum(rewards.rows[0]?.total)
  };
}

export async function getWalletTransactions(userId, limit = 25) {
  const { rows } = await query(
    `SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map((row) => ({ ...row, amount: toNum(row.amount) }));
}
