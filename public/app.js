(function(){
  function fmtSec(s){
    s = Number(s || 0);
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  }

  if (window.__LOBBY__) {
    const cards = Array.from(document.querySelectorAll('[data-room-card]'));
    async function refreshLobby(){
      try {
        const res = await fetch('/api/rooms');
        const data = await res.json();
        if (!data.ok) return;
        data.rooms.forEach((room) => {
          const card = cards.find((el) => el.dataset.slug === room.slug);
          if (!card) return;
          const pot = card.querySelector('[data-pot]');
          const jackpot = card.querySelector('[data-jackpot]');
          const secs = card.querySelector('[data-secs]');
          const status = card.querySelector('[data-status]');
          if (pot) pot.textContent = `${room.pot.toFixed(2)}₼`;
          if (jackpot) jackpot.textContent = room.jackpot !== null ? `${room.jackpot.toFixed(2)}₼` : '—';
          if (secs) secs.textContent = fmtSec(room.secsLeft);
          if (status) {
            status.textContent = room.status;
            status.className = `status-pill ${room.status}`;
          }
        });
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

    function ticketHtml(ticket){
      return `<div class="ticket-card live-ticket">${ticket.card.map((row) => `<div class="ticket-row">${row.map((cell) => {
        const marked = ticket.markedNumbers.includes(cell);
        return `<span class="ticket-cell ${cell === null ? 'empty' : ''} ${marked ? 'marked' : ''}">${cell ?? ''}</span>`;
      }).join('')}</div>`).join('')}</div>`;
    }

    function renderWinner(round){
      if (!round.winner) return;
      winnerBox.classList.remove('hidden');
      winnerBox.classList.toggle('loss', !round.winner.youWon);
      const jackpotText = round.jackpot ? ` · Jackpot: ${round.jackpot.prize.toFixed(2)}₼` : '';
      winnerBox.innerHTML = `<strong>${round.winner.youWon ? 'Təbriklər, qazandın!' : 'Raund tamamlandı'}</strong><br>${round.winner.name} ${round.winner.prize.toFixed(2)}₼ qazandı${jackpotText}`;
    }

    async function refreshPlay(){
      try {
        const res = await fetch(`/api/rooms/${slug}/state`);
        const data = await res.json();
        if (!data.ok) return;
        const { state } = data;
        status.textContent = state.round.status;
        pot.textContent = `${state.round.potAmount.toFixed(2)}₼`;
        players.textContent = state.round.playerCount;
        timer.textContent = fmtSec(state.round.secsLeft);
        jackpot.textContent = state.round.jackpotAmount !== null ? `${state.round.jackpotAmount.toFixed(2)}₼` : '—';
        balls.innerHTML = state.round.drawnNumbers.map((n) => `<span class="ball">${n}</span>`).join('');
        ticketWrap.innerHTML = state.round.myTickets.map(ticketHtml).join('') || '<p class="muted">Bu raund üçün biletiniz yoxdur.</p>';
        if (state.round.status === 'finished') renderWinner(state.round);
      } catch {}
    }

    refreshPlay();
    setInterval(refreshPlay, 1500);
  }
})();
