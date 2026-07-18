(() => {
  const statusLabels = {
    waiting: 'Gözləyir',
    starting: 'Başlamaqdadır',
    started: 'Canlı oyun',
    finished: 'Raund bitdi'
  };

  function fmtSec(s) {
    s = Number(s || 0);
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  }

  function setStatusNode(node, status) {
    if (!node) return;
    node.textContent = statusLabels[status] || status;
    node.className = `status-pill ${status}`;
  }

  if (window.__LOBBY__) {
    const cards = Array.from(document.querySelectorAll('[data-room-card]'));

    function renderLobbyRoom(room) {
      const card = cards.find((el) => el.dataset.slug === room.slug);
      if (!card) return;
      const pot = card.querySelector('[data-pot]');
      const jackpot = card.querySelector('[data-jackpot]');
      const secs = card.querySelector('[data-secs]');
      const status = card.querySelector('[data-status]');
      const drawn = card.querySelector('[data-drawn]');
      const winner = card.querySelector('[data-last-winner]');
      if (pot) pot.textContent = `${room.pot.toFixed(2)}₼`;
      if (jackpot) jackpot.textContent = room.jackpot !== null ? `${room.jackpot.toFixed(2)}₼` : '—';
      if (secs) secs.textContent = fmtSec(room.secsLeft);
      if (drawn) drawn.textContent = `${room.drawnCount}/90`;
      if (winner) winner.textContent = room.lastWinner || 'Hələ qalib yoxdur';
      setStatusNode(status, room.status);
    }

    async function refreshLobby() {
      try {
        const res = await fetch('/api/rooms');
        const data = await res.json();
        if (!data.ok) return;
        data.rooms.forEach(renderLobbyRoom);
      } catch {}
    }

    refreshLobby();
    setInterval(refreshLobby, 3000);
  }

  if (window.__PLAY_STATE__) {
    const slug = document.querySelector('[data-play]')?.dataset.roomSlug;
    const winnerBox = document.getElementById('winnerBox');
    const balls = document.getElementById('drawnBalls');
    const ticketWrap = document.getElementById('ticketWrap');
    const status = document.getElementById('gameStatus');
    const pot = document.getElementById('gamePot');
    const players = document.getElementById('gamePlayers');
    const timer = document.getElementById('gameTimer');
    const jackpot = document.getElementById('gameJackpot');
    const lastBall = document.getElementById('lastBall');
    const drawnCount = document.getElementById('drawnCount');
    const remainingCount = document.getElementById('remainingCount');
    const progressBar = document.getElementById('drawProgressBar');
    const callout = document.getElementById('calloutLine');

    function ticketHtml(ticket) {
      const total = ticket.card.flat().filter((cell) => Number.isInteger(cell)).length;
      const marked = ticket.markedNumbers.length;
      return `
        <div class="ticket-card live-ticket">
          <div class="ticket-meta"><strong>Bilet</strong><span>${marked}/${total} bağlandı</span></div>
          ${ticket.card.map((row) => `<div class="ticket-row">${row.map((cell) => {
            const isMarked = ticket.markedNumbers.includes(cell);
            return `<span class="ticket-cell ${cell === null ? 'empty' : ''} ${isMarked ? 'marked' : ''}">${cell ?? ''}</span>`;
          }).join('')}</div>`).join('')}
        </div>`;
    }

    function renderWinner(round) {
      if (!round.winner) return;
      winnerBox.classList.remove('hidden');
      winnerBox.classList.toggle('loss', !round.winner.youWon);
      const jackpotText = round.jackpot ? ` · Jackpot: ${round.jackpot.prize.toFixed(2)}₼` : '';
      winnerBox.innerHTML = `<strong>${round.winner.youWon ? 'Təbriklər, qalib oldun!' : 'Raund tamamlandı'}</strong><br>${round.winner.name} ${round.winner.prize.toFixed(2)}₼ qazandı${jackpotText}`;
    }

    function renderRound(state) {
      setStatusNode(status, state.round.status);
      pot.textContent = `${state.round.potAmount.toFixed(2)}₼`;
      players.textContent = state.round.playerCount;
      timer.textContent = fmtSec(state.round.secsLeft);
      jackpot.textContent = state.round.jackpotAmount !== null ? `${state.round.jackpotAmount.toFixed(2)}₼` : '—';
      const numbers = state.round.drawnNumbers || [];
      balls.innerHTML = numbers.map((n, idx) => `<span class="ball ${idx === numbers.length - 1 ? 'latest' : ''}">${n}</span>`).join('');
      ticketWrap.innerHTML = state.round.myTickets.map(ticketHtml).join('') || '<p class="muted">Bu raund üçün biletiniz yoxdur.</p>';
      const latest = numbers[numbers.length - 1];
      if (lastBall) lastBall.textContent = latest || '—';
      if (drawnCount) drawnCount.textContent = numbers.length;
      if (remainingCount) remainingCount.textContent = 90 - numbers.length;
      if (progressBar) progressBar.style.width = `${(numbers.length / 90) * 100}%`;
      if (callout) callout.textContent = latest ? `Aparıcı çağırdı: ${latest}` : 'Raund başlayanda ilk top burada görünəcək';
      if (state.round.status === 'finished') renderWinner(state.round);
    }

    async function refreshPlay() {
      try {
        const res = await fetch(`/api/rooms/${slug}/state`);
        const data = await res.json();
        if (!data.ok) return;
        renderRound(data.state);
      } catch {}
    }

    renderRound(window.__PLAY_STATE__);
    setInterval(refreshPlay, 1500);
  }
})();
