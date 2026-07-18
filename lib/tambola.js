function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function colRange(col) {
  if (col === 0) return [1, 9];
  if (col === 8) return [80, 90];
  return [col * 10, col * 10 + 9];
}

export function generateTicket() {
  const grid = [
    [null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null]
  ];

  for (let row = 0; row < 3; row += 1) {
    const cols = [...Array(9).keys()].sort(() => Math.random() - 0.5).slice(0, 5).sort((a, b) => a - b);
    for (const col of cols) {
      const [min, max] = colRange(col);
      let value;
      let duplicate = true;
      while (duplicate) {
        value = rand(min, max);
        duplicate = grid.some((r) => r[col] === value);
      }
      grid[row][col] = value;
    }
  }

  for (let col = 0; col < 9; col += 1) {
    const values = [];
    for (let row = 0; row < 3; row += 1) {
      if (grid[row][col] !== null) values.push(grid[row][col]);
    }
    values.sort((a, b) => a - b);
    let idx = 0;
    for (let row = 0; row < 3; row += 1) {
      if (grid[row][col] !== null) {
        grid[row][col] = values[idx];
        idx += 1;
      }
    }
  }

  return grid;
}

export function generateTickets(count) {
  return Array.from({ length: count }, () => generateTicket());
}

export function flattenTicket(card) {
  return card.flat().filter((n) => Number.isInteger(n));
}

export function completedRows(card, drawnSet) {
  return card.reduce((sum, row) => {
    const rowNumbers = row.filter((n) => Number.isInteger(n));
    if (rowNumbers.length && rowNumbers.every((n) => drawnSet.has(n))) return sum + 1;
    return sum;
  }, 0);
}

export function isWinningTicket(card, drawnNumbers, winType) {
  const drawnSet = new Set(drawnNumbers);
  const allNumbers = flattenTicket(card);
  if (winType === 'one_line') return completedRows(card, drawnSet) >= 1;
  return allNumbers.length > 0 && allNumbers.every((n) => drawnSet.has(n));
}

export function numbersMarked(card, drawnNumbers) {
  const drawn = new Set(drawnNumbers);
  return flattenTicket(card).filter((n) => drawn.has(n));
}

export function randomDrawOrder() {
  const numbers = Array.from({ length: 90 }, (_, i) => i + 1);
  for (let i = numbers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }
  return numbers;
}
