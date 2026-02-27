// ─────────────────────────────────────────────────────────────────────────────
// routes/game.js  —  Two Games: Fast Finger Tap + Tap War
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// GAME 1 — FAST FINGER TAP
// ══════════════════════════════════════════════════════════════════════════════
const FFT_DURATION     = 60;
const FFT_COUNTDOWN    = 3;
const FFT_COMBO_WINDOW = 1500;
const FFT_COMBO_THRESH = 5;
const FFT_COMBO_DUR    = 4000;
const FFT_COMBO_MULT   = 2;
const FFT_FREEZE_DUR   = 3000;
const FFT_SUDDEN_TIME  = 10;
const FFT_ROUNDS_WIN   = 2;

const makeFftPlayer = () => ({
  score: 0, socketId: null, roundWins: 0,
  frozen: false, freezeUsed: false,
  comboActive: false, comboTimer: null, tapTimes: [],
});

let fft = {
  phase: 'idle', countdown: FFT_COUNTDOWN, timeLeft: FFT_DURATION,
  round: 1, matchWinner: null, roundWinner: null,
  p1: makeFftPlayer(), p2: makeFftPlayer(),
};
let fftGameTimer = null, fftCdTimer = null;
let fftP1FreezeTimer = null, fftP2FreezeTimer = null;

const fftSnap = () => ({
  game: 'fft',
  phase: fft.phase, countdown: fft.countdown, timeLeft: fft.timeLeft,
  round: fft.round, matchWinner: fft.matchWinner, roundWinner: fft.roundWinner,
  p1Score: fft.p1.score, p2Score: fft.p2.score,
  p1RoundWins: fft.p1.roundWins, p2RoundWins: fft.p2.roundWins,
  p1Frozen: fft.p1.frozen, p2Frozen: fft.p2.frozen,
  p1FreezeUsed: fft.p1.freezeUsed, p2FreezeUsed: fft.p2.freezeUsed,
  p1Combo: fft.p1.comboActive, p2Combo: fft.p2.comboActive,
});

const fftTriggerCombo = (io, player, key) => {
  if (player.comboTimer) clearTimeout(player.comboTimer);
  player.comboActive = true;
  player.tapTimes = [];
  io.emit('gameState', { ...fftSnap(), event: 'combo', who: key });
  player.comboTimer = setTimeout(() => {
    player.comboActive = false;
    player.comboTimer = null;
    io.emit('gameState', fftSnap());
  }, FFT_COMBO_DUR);
};

const fftRecordTap = (io, player, key) => {
  const now = Date.now();
  player.tapTimes = player.tapTimes.filter(t => now - t < FFT_COMBO_WINDOW);
  player.tapTimes.push(now);
  if (!player.comboActive && player.tapTimes.length >= FFT_COMBO_THRESH)
    fftTriggerCombo(io, player, key);
};

const fftFreeze = (io, target, targetKey, attackerKey) => {
  if (target.frozen) return;
  target.frozen = true;
  io.emit('gameState', { ...fftSnap(), event: 'freeze', who: targetKey });
  const setter = targetKey === 'p1'
    ? (v) => { fftP1FreezeTimer = v; }
    : (v) => { fftP2FreezeTimer = v; };
  const ref = targetKey === 'p1' ? fftP1FreezeTimer : fftP2FreezeTimer;
  if (ref) clearTimeout(ref);
  setter(setTimeout(() => {
    fft[targetKey].frozen = false;
    io.emit('gameState', fftSnap());
  }, FFT_FREEZE_DUR));
};

const fftEndRound = (io) => {
  clearInterval(fftGameTimer); fftGameTimer = null;
  let rw = fft.p1.score > fft.p2.score ? 'p1'
         : fft.p2.score > fft.p1.score ? 'p2' : 'tie';
  if (rw !== 'tie') fft[rw].roundWins++;
  fft.roundWinner = rw;
  if (fft.p1.roundWins >= FFT_ROUNDS_WIN) {
    fft.phase = 'finished'; fft.matchWinner = 'p1';
    io.emit('gameState', fftSnap());
  } else if (fft.p2.roundWins >= FFT_ROUNDS_WIN) {
    fft.phase = 'finished'; fft.matchWinner = 'p2';
    io.emit('gameState', fftSnap());
  } else {
    fft.phase = 'roundOver';
    io.emit('gameState', fftSnap());
    setTimeout(() => { fft.round++; fftStartCountdown(io); }, 3000);
  }
};

const fftSuddenDeath = (io) => {
  fft.phase = 'suddenDeath'; fft.timeLeft = FFT_SUDDEN_TIME;
  fft.p1.score = 0; fft.p2.score = 0;
  io.emit('gameState', { ...fftSnap(), event: 'suddenDeath' });
  fftGameTimer = setInterval(() => {
    fft.timeLeft--;
    io.emit('gameState', fftSnap());
    if (fft.timeLeft <= 0) {
      clearInterval(fftGameTimer);
      fft.phase = 'finished'; fft.matchWinner = 'tie';
      io.emit('gameState', fftSnap());
    }
  }, 1000);
};

const fftReset = (io) => {
  clearInterval(fftGameTimer); clearInterval(fftCdTimer);
  if (fftP1FreezeTimer) clearTimeout(fftP1FreezeTimer);
  if (fftP2FreezeTimer) clearTimeout(fftP2FreezeTimer);
  fft = {
    phase: 'idle', countdown: FFT_COUNTDOWN, timeLeft: FFT_DURATION,
    round: 1, matchWinner: null, roundWinner: null,
    p1: makeFftPlayer(), p2: makeFftPlayer(),
  };
  io.emit('gameState', fftSnap());
};

const fftStartCountdown = (io) => {
  if (fft.phase !== 'idle' && fft.phase !== 'roundOver') return;
  const p1w = fft.p1.roundWins, p2w = fft.p2.roundWins, r = fft.round;
  fft.phase = 'countdown'; fft.countdown = FFT_COUNTDOWN;
  fft.timeLeft = FFT_DURATION; fft.roundWinner = null;
  fft.p1 = { ...makeFftPlayer(), roundWins: p1w };
  fft.p2 = { ...makeFftPlayer(), roundWins: p2w };
  fft.round = r;
  io.emit('gameState', fftSnap());
  fftCdTimer = setInterval(() => {
    fft.countdown--;
    if (fft.countdown <= 0) { clearInterval(fftCdTimer); fftStartPlaying(io); }
    else io.emit('gameState', fftSnap());
  }, 1000);
};

const fftStartPlaying = (io) => {
  fft.phase = 'playing'; fft.timeLeft = FFT_DURATION;
  io.emit('gameState', fftSnap());
  fftGameTimer = setInterval(() => {
    fft.timeLeft--;
    io.emit('gameState', fftSnap());
    if (fft.timeLeft <= 0) {
      clearInterval(fftGameTimer);
      fft.p1.score === fft.p2.score ? fftSuddenDeath(io) : fftEndRound(io);
    }
  }, 1000);
};

// ══════════════════════════════════════════════════════════════════════════════
// GAME 2 — TAP WAR
// ══════════════════════════════════════════════════════════════════════════════
// Bar position: -100 (full P1 win) to +100 (full P2 win), starts at 0
// Each tap moves bar 1 unit toward tapper's side
// First to push bar to ±100 wins the round (best of 3)
// Twist: Power Surge — tap 8x in 1s = SURGE, next 3 taps = 3 units each
// Twist: Taunt — opponent's bar briefly bounces back 5 units (once per round, hold 1.5s)

const TW_WIN_THRESHOLD = 100;  // bar units to win
const TW_COUNTDOWN     = 3;
const TW_SURGE_WINDOW  = 1000; // ms
const TW_SURGE_THRESH  = 8;
const TW_SURGE_TAPS    = 3;    // bonus taps during surge
const TW_SURGE_MULT    = 3;    // units per surge tap
const TW_TAUNT_HOLD    = 1500; // ms
const TW_TAUNT_BOUNCE  = 8;    // units bounced back
const TW_ROUNDS_WIN    = 2;

const makeTwPlayer = () => ({
  socketId: null, roundWins: 0,
  surgeActive: false, surgeCount: 0, surgeTapTimes: [],
  tauntUsed: false,
});

let tw = {
  phase: 'idle',        // idle|countdown|playing|finished
  countdown: TW_COUNTDOWN,
  barPos: 0,            // -100 = P1 side wins, +100 = P2 side wins
  round: 1,
  matchWinner: null,
  roundWinner: null,
  p1: makeTwPlayer(),
  p2: makeTwPlayer(),
};
let twCdTimer = null;

const twSnap = () => ({
  game: 'war',
  phase: tw.phase, countdown: tw.countdown,
  barPos: tw.barPos, round: tw.round,
  matchWinner: tw.matchWinner, roundWinner: tw.roundWinner,
  p1RoundWins: tw.p1.roundWins, p2RoundWins: tw.p2.roundWins,
  p1Surge: tw.p1.surgeActive, p2Surge: tw.p2.surgeActive,
  p1TauntUsed: tw.p1.tauntUsed, p2TauntUsed: tw.p2.tauntUsed,
});

const twTriggerSurge = (io, player, key) => {
  player.surgeActive = true;
  player.surgeCount  = 0;
  player.surgeTapTimes = [];
  io.emit('gameState', { ...twSnap(), event: 'surge', who: key });
  console.log(`⚡ ${key.toUpperCase()} POWER SURGE!`);
};

const twRecordTap = (io, player, key) => {
  const now = Date.now();
  player.surgeTapTimes = player.surgeTapTimes.filter(t => now - t < TW_SURGE_WINDOW);
  player.surgeTapTimes.push(now);
  if (!player.surgeActive && player.surgeTapTimes.length >= TW_SURGE_THRESH)
    twTriggerSurge(io, player, key);
};

const twEndRound = (io, winner) => {
  tw.roundWinner = winner;
  if (winner !== 'tie') tw[winner].roundWins++;

  if (tw.p1.roundWins >= TW_ROUNDS_WIN) {
    tw.phase = 'finished'; tw.matchWinner = 'p1';
    io.emit('gameState', twSnap());
  } else if (tw.p2.roundWins >= TW_ROUNDS_WIN) {
    tw.phase = 'finished'; tw.matchWinner = 'p2';
    io.emit('gameState', twSnap());
  } else {
    tw.phase = 'roundOver';
    io.emit('gameState', twSnap());
    setTimeout(() => { tw.round++; twStartCountdown(io); }, 3000);
  }
};

const twReset = (io) => {
  clearInterval(twCdTimer);
  tw = {
    phase: 'idle', countdown: TW_COUNTDOWN, barPos: 0,
    round: 1, matchWinner: null, roundWinner: null,
    p1: makeTwPlayer(), p2: makeTwPlayer(),
  };
  io.emit('gameState', twSnap());
};

const twStartCountdown = (io) => {
  const p1w = tw.p1.roundWins, p2w = tw.p2.roundWins, r = tw.round;
  tw.phase = 'countdown'; tw.countdown = TW_COUNTDOWN;
  tw.barPos = 0; tw.roundWinner = null;
  tw.p1 = { ...makeTwPlayer(), roundWins: p1w };
  tw.p2 = { ...makeTwPlayer(), roundWins: p2w };
  tw.round = r;
  io.emit('gameState', twSnap());
  twCdTimer = setInterval(() => {
    tw.countdown--;
    if (tw.countdown <= 0) {
      clearInterval(twCdTimer);
      tw.phase = 'playing';
      io.emit('gameState', twSnap());
      console.log(`⚔️  Tap War Round ${tw.round} started!`);
    } else {
      io.emit('gameState', twSnap());
    }
  }, 1000);
};

// ══════════════════════════════════════════════════════════════════════════════
// LOBBY STATE — which game is selected
// ══════════════════════════════════════════════════════════════════════════════
let lobbyGame = 'fft'; // 'fft' | 'war'

const lobbySnap = () => ({ lobby: true, selectedGame: lobbyGame });

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET HANDLERS
// ══════════════════════════════════════════════════════════════════════════════
const initializeGame = (io) => {
  io.on('connection', (socket) => {

    // ── Lobby: select game
    socket.on('selectGame', ({ game }) => {
      if (game !== 'fft' && game !== 'war') return;
      // Only switch if no game is in progress
      const fftBusy = fft.phase !== 'idle' && fft.phase !== 'finished';
      const twBusy  = tw.phase  !== 'idle' && tw.phase  !== 'finished';
      if (fftBusy || twBusy) return;
      lobbyGame = game;
      io.emit('lobbyState', lobbySnap());
      console.log(`🎮 Game selected: ${game}`);
    });

    socket.on('getLobbyState', () => {
      socket.emit('lobbyState', lobbySnap());
    });

    // ── Get current game state
    socket.on('getGameState', () => {
      socket.emit('lobbyState', lobbySnap());
      socket.emit('gameState', lobbyGame === 'fft' ? fftSnap() : twSnap());
    });

    // ══ FAST FINGER TAP events ═════════════════════════════════════════════

    socket.on('fft_tap', ({ role }) => {
      if (fft.phase !== 'playing' && fft.phase !== 'suddenDeath') return;
      if (role !== 'p1' && role !== 'p2') return;
      const player = fft[role];
      if (player.frozen) return;
      const pts = player.comboActive ? FFT_COMBO_MULT : 1;
      player.score += pts;
      if (fft.phase === 'playing') fftRecordTap(io, player, role);
      if (fft.phase === 'suddenDeath') {
        clearInterval(fftGameTimer);
        fftEndRound(io);
        return;
      }
      io.emit('gameState', fftSnap());
    });

    socket.on('fft_freeze', ({ role }) => {
      if (fft.phase !== 'playing') return;
      if (role !== 'p1' && role !== 'p2') return;
      const attacker = fft[role];
      if (attacker.freezeUsed) return;
      attacker.freezeUsed = true;
      fftFreeze(io, fft[role === 'p1' ? 'p2' : 'p1'], role === 'p1' ? 'p2' : 'p1', role);
    });

    socket.on('fft_start',  () => { if (fft.phase === 'idle') fftStartCountdown(io); });
    socket.on('fft_reset',  () => { if (fft.phase === 'finished') fftReset(io); });

    // ══ TAP WAR events ════════════════════════════════════════════════════

    socket.on('war_tap', ({ role }) => {
      if (tw.phase !== 'playing') return;
      if (role !== 'p1' && role !== 'p2') return;
      const player = tw[role];

      // Surge: 3 units per tap, count down surge uses
      let units = 1;
      if (player.surgeActive) {
        units = TW_SURGE_MULT;
        player.surgeCount++;
        if (player.surgeCount >= TW_SURGE_TAPS) {
          player.surgeActive = false;
          player.surgeCount  = 0;
          console.log(`💨 ${role.toUpperCase()} surge ended`);
        }
      } else {
        twRecordTap(io, player, role);
      }

      // P1 taps push bar LEFT (negative), P2 taps push bar RIGHT (positive)
      tw.barPos += role === 'p1' ? -units : units;
      tw.barPos = Math.max(-TW_WIN_THRESHOLD, Math.min(TW_WIN_THRESHOLD, tw.barPos));

      io.emit('gameState', twSnap());

      // Check win condition
      if (tw.barPos <= -TW_WIN_THRESHOLD) { twEndRound(io, 'p1'); }
      else if (tw.barPos >= TW_WIN_THRESHOLD) { twEndRound(io, 'p2'); }
    });

    socket.on('war_taunt', ({ role }) => {
      if (tw.phase !== 'playing') return;
      if (role !== 'p1' && role !== 'p2') return;
      const attacker = tw[role];
      if (attacker.tauntUsed) return;
      attacker.tauntUsed = true;

      // Bounce bar back toward attacker
      const bounce = role === 'p1' ? -TW_TAUNT_BOUNCE : TW_TAUNT_BOUNCE;
      tw.barPos += bounce;
      tw.barPos = Math.max(-TW_WIN_THRESHOLD, Math.min(TW_WIN_THRESHOLD, tw.barPos));

      io.emit('gameState', { ...twSnap(), event: 'taunt', who: role });
      console.log(`😤 ${role.toUpperCase()} TAUNT! Bar bounced ${bounce}`);
    });

    socket.on('war_start', () => {
      if (tw.phase === 'idle') twStartCountdown(io);
    });
    socket.on('war_reset', () => {
      if (tw.phase === 'finished') twReset(io);
    });
  });

  console.log('🎮 Games initialized: Fast Finger Tap + Tap War');
};

module.exports = { initializeGame };