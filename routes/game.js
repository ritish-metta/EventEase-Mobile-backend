// ─────────────────────────────────────────────────────────────────────────────
// routes/game.js  —  Five Games: FFT + Tap War + Engine Power + Electric Duel + Boxing Match
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
  player.comboActive = true; player.tapTimes = [];
  io.emit('gameState', { ...fftSnap(), event: 'combo', who: key });
  player.comboTimer = setTimeout(() => {
    player.comboActive = false; player.comboTimer = null;
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

const fftFreeze = (io, target, targetKey) => {
  if (target.frozen) return;
  target.frozen = true;
  io.emit('gameState', { ...fftSnap(), event: 'freeze', who: targetKey });
  const ref = targetKey === 'p1' ? fftP1FreezeTimer : fftP2FreezeTimer;
  if (ref) clearTimeout(ref);
  const t = setTimeout(() => { fft[targetKey].frozen = false; io.emit('gameState', fftSnap()); }, FFT_FREEZE_DUR);
  if (targetKey === 'p1') fftP1FreezeTimer = t; else fftP2FreezeTimer = t;
};

const fftEndRound = (io) => {
  clearInterval(fftGameTimer); fftGameTimer = null;
  let rw = fft.p1.score > fft.p2.score ? 'p1' : fft.p2.score > fft.p1.score ? 'p2' : 'tie';
  if (rw !== 'tie') fft[rw].roundWins++;
  fft.roundWinner = rw;
  if (fft.p1.roundWins >= FFT_ROUNDS_WIN) {
    fft.phase = 'finished'; fft.matchWinner = 'p1'; io.emit('gameState', fftSnap());
  } else if (fft.p2.roundWins >= FFT_ROUNDS_WIN) {
    fft.phase = 'finished'; fft.matchWinner = 'p2'; io.emit('gameState', fftSnap());
  } else {
    fft.phase = 'roundOver'; io.emit('gameState', fftSnap());
    setTimeout(() => { fft.round++; fftStartCountdown(io); }, 3000);
  }
};

const fftSuddenDeath = (io) => {
  fft.phase = 'suddenDeath'; fft.timeLeft = FFT_SUDDEN_TIME;
  fft.p1.score = 0; fft.p2.score = 0;
  io.emit('gameState', { ...fftSnap(), event: 'suddenDeath' });
  fftGameTimer = setInterval(() => {
    fft.timeLeft--; io.emit('gameState', fftSnap());
    if (fft.timeLeft <= 0) {
      clearInterval(fftGameTimer); fft.phase = 'finished'; fft.matchWinner = 'tie';
      io.emit('gameState', fftSnap());
    }
  }, 1000);
};

const fftReset = (io) => {
  clearInterval(fftGameTimer); clearInterval(fftCdTimer);
  if (fftP1FreezeTimer) clearTimeout(fftP1FreezeTimer);
  if (fftP2FreezeTimer) clearTimeout(fftP2FreezeTimer);
  fft = { phase: 'idle', countdown: FFT_COUNTDOWN, timeLeft: FFT_DURATION,
    round: 1, matchWinner: null, roundWinner: null, p1: makeFftPlayer(), p2: makeFftPlayer() };
  io.emit('gameState', fftSnap());
};

const fftStartCountdown = (io) => {
  if (fft.phase !== 'idle' && fft.phase !== 'roundOver') return;
  const p1w = fft.p1.roundWins, p2w = fft.p2.roundWins, r = fft.round;
  fft.phase = 'countdown'; fft.countdown = FFT_COUNTDOWN; fft.timeLeft = FFT_DURATION; fft.roundWinner = null;
  fft.p1 = { ...makeFftPlayer(), roundWins: p1w }; fft.p2 = { ...makeFftPlayer(), roundWins: p2w }; fft.round = r;
  io.emit('gameState', fftSnap());
  fftCdTimer = setInterval(() => {
    fft.countdown--;
    if (fft.countdown <= 0) { clearInterval(fftCdTimer); fftStartPlaying(io); }
    else io.emit('gameState', fftSnap());
  }, 1000);
};

const fftStartPlaying = (io) => {
  fft.phase = 'playing'; fft.timeLeft = FFT_DURATION; io.emit('gameState', fftSnap());
  fftGameTimer = setInterval(() => {
    fft.timeLeft--; io.emit('gameState', fftSnap());
    if (fft.timeLeft <= 0) { clearInterval(fftGameTimer); fft.p1.score === fft.p2.score ? fftSuddenDeath(io) : fftEndRound(io); }
  }, 1000);
};

// ══════════════════════════════════════════════════════════════════════════════
// GAME 2 — TAP WAR
// ══════════════════════════════════════════════════════════════════════════════
const TW_WIN_THRESHOLD = 100;
const TW_COUNTDOWN     = 3;
const TW_SURGE_WINDOW  = 1000;
const TW_SURGE_THRESH  = 8;
const TW_SURGE_TAPS    = 3;
const TW_SURGE_MULT    = 3;
const TW_TAUNT_BOUNCE  = 8;
const TW_ROUNDS_WIN    = 2;

const makeTwPlayer = () => ({
  socketId: null, roundWins: 0, surgeActive: false, surgeCount: 0, surgeTapTimes: [], tauntUsed: false,
});

let tw = {
  phase: 'idle', countdown: TW_COUNTDOWN, barPos: 0, round: 1,
  matchWinner: null, roundWinner: null, p1: makeTwPlayer(), p2: makeTwPlayer(),
};
let twCdTimer = null;

const twSnap = () => ({
  game: 'war', phase: tw.phase, countdown: tw.countdown, barPos: tw.barPos, round: tw.round,
  matchWinner: tw.matchWinner, roundWinner: tw.roundWinner,
  p1RoundWins: tw.p1.roundWins, p2RoundWins: tw.p2.roundWins,
  p1Surge: tw.p1.surgeActive, p2Surge: tw.p2.surgeActive,
  p1TauntUsed: tw.p1.tauntUsed, p2TauntUsed: tw.p2.tauntUsed,
});

const twTriggerSurge = (io, player, key) => {
  player.surgeActive = true; player.surgeCount = 0; player.surgeTapTimes = [];
  io.emit('gameState', { ...twSnap(), event: 'surge', who: key });
};

const twRecordTap = (io, player, key) => {
  const now = Date.now();
  player.surgeTapTimes = player.surgeTapTimes.filter(t => now - t < TW_SURGE_WINDOW);
  player.surgeTapTimes.push(now);
  if (!player.surgeActive && player.surgeTapTimes.length >= TW_SURGE_THRESH) twTriggerSurge(io, player, key);
};

const twEndRound = (io, winner) => {
  tw.roundWinner = winner;
  if (winner !== 'tie') tw[winner].roundWins++;
  if (tw.p1.roundWins >= TW_ROUNDS_WIN) { tw.phase = 'finished'; tw.matchWinner = 'p1'; io.emit('gameState', twSnap()); }
  else if (tw.p2.roundWins >= TW_ROUNDS_WIN) { tw.phase = 'finished'; tw.matchWinner = 'p2'; io.emit('gameState', twSnap()); }
  else { tw.phase = 'roundOver'; io.emit('gameState', twSnap()); setTimeout(() => { tw.round++; twStartCountdown(io); }, 3000); }
};

const twReset = (io) => {
  clearInterval(twCdTimer);
  tw = { phase: 'idle', countdown: TW_COUNTDOWN, barPos: 0, round: 1, matchWinner: null, roundWinner: null, p1: makeTwPlayer(), p2: makeTwPlayer() };
  io.emit('gameState', twSnap());
};

const twStartCountdown = (io) => {
  const p1w = tw.p1.roundWins, p2w = tw.p2.roundWins, r = tw.round;
  tw.phase = 'countdown'; tw.countdown = TW_COUNTDOWN; tw.barPos = 0; tw.roundWinner = null;
  tw.p1 = { ...makeTwPlayer(), roundWins: p1w }; tw.p2 = { ...makeTwPlayer(), roundWins: p2w }; tw.round = r;
  io.emit('gameState', twSnap());
  twCdTimer = setInterval(() => {
    tw.countdown--;
    if (tw.countdown <= 0) { clearInterval(twCdTimer); tw.phase = 'playing'; io.emit('gameState', twSnap()); }
    else io.emit('gameState', twSnap());
  }, 1000);
};

// ══════════════════════════════════════════════════════════════════════════════
// GAME 3 — ENGINE POWER
// ══════════════════════════════════════════════════════════════════════════════
const EP_TICK_MS        = 100;
const EP_HEAT_PER_TAP   = 8;
const EP_HEAT_DECAY     = 1.2;
const EP_OVERHEAT_LIMIT = 85;
const EP_SWEET_LOW      = 55;
const EP_SWEET_HIGH     = 80;
const EP_STALL_MS       = 3000;
const EP_BURST_THRESH   = 95;
const EP_BURST_DUR      = 4000;
const EP_VENT_HEAT_SPIKE= 30;
const EP_TRACK_LENGTH   = 100;
const EP_COUNTDOWN      = 3;
const EP_ROUNDS_WIN     = 2;

const epSpeed = (heat, burst, stalled) => {
  if (stalled) return -0.3;
  if (burst)   return 1.4;
  if (heat >= EP_SWEET_LOW && heat <= EP_SWEET_HIGH) return 1.0;
  if (heat < EP_SWEET_LOW) return 0.15 + (heat / EP_SWEET_LOW) * 0.5;
  return 1.0 - ((heat - EP_SWEET_HIGH) / (EP_OVERHEAT_LIMIT - EP_SWEET_HIGH)) * 0.7;
};

const makeEpPlayer = () => ({
  socketId: null, roundWins: 0, heat: 0, progress: 0,
  stalled: false, stallTimer: null, burst: false, burstTimer: null, burstUsed: false, ventUsed: false, tapTimes: [],
});

let ep = { phase: 'idle', countdown: EP_COUNTDOWN, round: 1, matchWinner: null, roundWinner: null, p1: makeEpPlayer(), p2: makeEpPlayer() };
let epTickTimer = null, epCdTimer = null;

const epSnap = () => ({
  game: 'ep', phase: ep.phase, countdown: ep.countdown, round: ep.round,
  matchWinner: ep.matchWinner, roundWinner: ep.roundWinner,
  p1Progress: Math.round(ep.p1.progress * 10) / 10, p2Progress: Math.round(ep.p2.progress * 10) / 10,
  p1Heat: Math.round(ep.p1.heat), p2Heat: Math.round(ep.p2.heat),
  p1RoundWins: ep.p1.roundWins, p2RoundWins: ep.p2.roundWins,
  p1Stalled: ep.p1.stalled, p2Stalled: ep.p2.stalled,
  p1Burst: ep.p1.burst, p2Burst: ep.p2.burst,
  p1BurstUsed: ep.p1.burstUsed, p2BurstUsed: ep.p2.burstUsed,
  p1VentUsed: ep.p1.ventUsed, p2VentUsed: ep.p2.ventUsed,
});

const epOverheat = (io, player, key) => {
  if (player.stalled) return;
  player.stalled = true; player.heat = EP_OVERHEAT_LIMIT + 5;
  if (player.burst) { clearTimeout(player.burstTimer); player.burst = false; }
  io.emit('gameState', { ...epSnap(), event: 'overheat', who: key });
  if (player.stallTimer) clearTimeout(player.stallTimer);
  player.stallTimer = setTimeout(() => { player.stalled = false; player.heat = 20; io.emit('gameState', epSnap()); }, EP_STALL_MS);
};

const epTriggerBurst = (io, player, key) => {
  if (player.burst || player.burstUsed) return;
  player.burst = true; player.burstUsed = true;
  io.emit('gameState', { ...epSnap(), event: 'burst', who: key });
  if (player.burstTimer) clearTimeout(player.burstTimer);
  player.burstTimer = setTimeout(() => { player.burst = false; player.heat = EP_OVERHEAT_LIMIT - 5; io.emit('gameState', epSnap()); }, EP_BURST_DUR);
};

const epEndRound = (io, winner) => {
  clearInterval(epTickTimer); epTickTimer = null;
  ep.roundWinner = winner;
  if (winner !== 'tie') ep[winner].roundWins++;
  ['p1','p2'].forEach(k => { if (ep[k].stallTimer) clearTimeout(ep[k].stallTimer); if (ep[k].burstTimer) clearTimeout(ep[k].burstTimer); });
  if (ep.p1.roundWins >= EP_ROUNDS_WIN) { ep.phase = 'finished'; ep.matchWinner = 'p1'; io.emit('gameState', epSnap()); }
  else if (ep.p2.roundWins >= EP_ROUNDS_WIN) { ep.phase = 'finished'; ep.matchWinner = 'p2'; io.emit('gameState', epSnap()); }
  else { ep.phase = 'roundOver'; io.emit('gameState', epSnap()); setTimeout(() => { ep.round++; epStartCountdown(io); }, 3000); }
};

const epReset = (io) => {
  clearInterval(epTickTimer); clearInterval(epCdTimer);
  ['p1','p2'].forEach(k => { if (ep[k].stallTimer) clearTimeout(ep[k].stallTimer); if (ep[k].burstTimer) clearTimeout(ep[k].burstTimer); });
  ep = { phase: 'idle', countdown: EP_COUNTDOWN, round: 1, matchWinner: null, roundWinner: null, p1: makeEpPlayer(), p2: makeEpPlayer() };
  io.emit('gameState', epSnap());
};

const epStartCountdown = (io) => {
  if (ep.phase !== 'idle' && ep.phase !== 'roundOver') return;
  const p1w = ep.p1.roundWins, p2w = ep.p2.roundWins, r = ep.round;
  ep.phase = 'countdown'; ep.countdown = EP_COUNTDOWN; ep.roundWinner = null;
  ep.p1 = { ...makeEpPlayer(), roundWins: p1w }; ep.p2 = { ...makeEpPlayer(), roundWins: p2w }; ep.round = r;
  io.emit('gameState', epSnap());
  epCdTimer = setInterval(() => {
    ep.countdown--;
    if (ep.countdown <= 0) { clearInterval(epCdTimer); epStartPlaying(io); }
    else io.emit('gameState', epSnap());
  }, 1000);
};

const epStartPlaying = (io) => {
  ep.phase = 'playing'; ep.p1.progress = 0; ep.p2.progress = 0; ep.p1.heat = 0; ep.p2.heat = 0;
  io.emit('gameState', epSnap());
  epTickTimer = setInterval(() => {
    ['p1','p2'].forEach(key => {
      const p = ep[key];
      if (!p.stalled) p.heat = Math.max(0, p.heat - EP_HEAT_DECAY);
      p.progress = Math.max(0, Math.min(EP_TRACK_LENGTH, p.progress + epSpeed(p.heat, p.burst, p.stalled)));
      if (!p.stalled && p.heat >= EP_OVERHEAT_LIMIT) epOverheat(io, p, key);
      if (!p.stalled && !p.burst && !p.burstUsed && p.heat >= EP_BURST_THRESH) epTriggerBurst(io, p, key);
    });
    io.emit('gameState', epSnap());
    if (ep.p1.progress >= EP_TRACK_LENGTH && ep.p2.progress >= EP_TRACK_LENGTH) epEndRound(io, 'tie');
    else if (ep.p1.progress >= EP_TRACK_LENGTH) epEndRound(io, 'p1');
    else if (ep.p2.progress >= EP_TRACK_LENGTH) epEndRound(io, 'p2');
  }, EP_TICK_MS);
};

// ══════════════════════════════════════════════════════════════════════════════
// GAME 4 — ELECTRIC DUEL
// ══════════════════════════════════════════════════════════════════════════════
const ED_COUNTDOWN      = 3;
const ED_MAX_HITS       = 5;
const ED_CHARGE_PER_TAP = 4;
const ED_FIRE_DELAY     = 600;
const ED_RESET_DELAY    = 1200;

const makeEdPlayer = () => ({ socketId: null, hits: 0, tapCount: 0, absorbActive: false, absorbUsed: false });

let ed = {
  phase: 'idle', countdown: ED_COUNTDOWN, ballCharge: 0, ballOwner: 0,
  totalTaps: 0, isFiring: false, firingAt: null, matchWinner: null,
  p1: makeEdPlayer(), p2: makeEdPlayer(),
};
let edCdTimer = null, edFireTimer = null;

const edSnap = () => ({
  game: 'ed', phase: ed.phase, countdown: ed.countdown,
  ballCharge: Math.round(ed.ballCharge), ballOwner: Math.round(ed.ballOwner),
  p1Charge: Math.round(ed.p1.tapCount / Math.max(ed.totalTaps, 1) * 100),
  p2Charge: Math.round(ed.p2.tapCount / Math.max(ed.totalTaps, 1) * 100),
  p1Hits: ed.p1.hits, p2Hits: ed.p2.hits,
  p1Absorb: ed.p1.absorbActive, p2Absorb: ed.p2.absorbActive,
  p1AbsorbUsed: ed.p1.absorbUsed, p2AbsorbUsed: ed.p2.absorbUsed,
  isFiring: ed.isFiring, firingAt: ed.firingAt, matchWinner: ed.matchWinner,
});

const edFire = (io) => {
  if (ed.isFiring) return;
  const p1Taps = ed.p1.tapCount, p2Taps = ed.p2.tapCount;
  const loser = p1Taps < p2Taps ? 'p1' : p2Taps < p1Taps ? 'p2' : (Math.random() < 0.5 ? 'p1' : 'p2');
  ed.isFiring = true; ed.firingAt = loser; ed.ballOwner = loser === 'p1' ? -100 : 100;
  io.emit('gameState', { ...edSnap(), event: 'fire', who: loser });
  if (edFireTimer) clearTimeout(edFireTimer);
  edFireTimer = setTimeout(() => {
    const target = ed[loser];
    if (target.absorbActive) {
      target.absorbActive = false;
      io.emit('gameState', { ...edSnap(), event: 'absorb', who: loser });
      setTimeout(() => edResetCycle(io), ED_RESET_DELAY);
    } else {
      target.hits++;
      io.emit('gameState', { ...edSnap(), event: 'hit', who: loser });
      if (target.hits >= ED_MAX_HITS) { setTimeout(() => edFinish(io, loser === 'p1' ? 'p2' : 'p1'), ED_RESET_DELAY); }
      else { setTimeout(() => edResetCycle(io), ED_RESET_DELAY); }
    }
  }, ED_FIRE_DELAY);
};

const edResetCycle = (io) => {
  ed.isFiring = false; ed.firingAt = null; ed.ballCharge = 0; ed.ballOwner = 0;
  ed.totalTaps = 0; ed.p1.tapCount = 0; ed.p2.tapCount = 0;
  io.emit('gameState', edSnap());
};

const edFinish = (io, winner) => { ed.phase = 'finished'; ed.matchWinner = winner; io.emit('gameState', edSnap()); };

const edReset = (io) => {
  clearInterval(edCdTimer); if (edFireTimer) clearTimeout(edFireTimer);
  ed = { phase: 'idle', countdown: ED_COUNTDOWN, ballCharge: 0, ballOwner: 0, totalTaps: 0, isFiring: false, firingAt: null, matchWinner: null, p1: makeEdPlayer(), p2: makeEdPlayer() };
  io.emit('gameState', edSnap());
};

const edStartCountdown = (io) => {
  if (ed.phase !== 'idle' && ed.phase !== 'finished') return;
  ed.phase = 'countdown'; ed.countdown = ED_COUNTDOWN; ed.p1 = makeEdPlayer(); ed.p2 = makeEdPlayer();
  ed.ballCharge = 0; ed.ballOwner = 0; ed.totalTaps = 0; ed.matchWinner = null; ed.isFiring = false; ed.firingAt = null;
  io.emit('gameState', edSnap());
  edCdTimer = setInterval(() => {
    ed.countdown--;
    if (ed.countdown <= 0) { clearInterval(edCdTimer); ed.phase = 'playing'; io.emit('gameState', edSnap()); }
    else io.emit('gameState', edSnap());
  }, 1000);
};

// ══════════════════════════════════════════════════════════════════════════════
// GAME 5 — BOXING MATCH
// ══════════════════════════════════════════════════════════════════════════════
// - Jab (tap):          damages opponent stamina by BX_JAB_DAMAGE
// - Heavy (hold 800ms): damages opponent stamina by BX_HEAVY_DAMAGE (2x)
// - Combo:              3+ jabs in window = x1.5 damage, 6+ = x2
// - Block:              both tap within BX_BLOCK_WINDOW ms = no damage
// - Knockdown:          stamina hits 0 → knockdown scored, 3s pause, stamina resets
// - Round end:          after BX_ROUND_DURATION secs, most knockdowns wins round
// - Tie on knockdowns:  higher remaining stamina wins round
// - Match:              best of 3 rounds

const BX_COUNTDOWN       = 3;
const BX_ROUND_DURATION  = 45;
const BX_ROUNDS          = 3;
const BX_ROUNDS_WIN      = 2;
const BX_JAB_DAMAGE      = 8;
const BX_HEAVY_DAMAGE    = 18;
const BX_COMBO_WINDOW    = 1200;
const BX_COMBO_THRESH_1  = 3;
const BX_COMBO_THRESH_2  = 6;
const BX_CHARGE_TIME     = 800;
const BX_BLOCK_WINDOW    = 80;
const BX_KNOCKDOWN_PAUSE = 3000;

const makeBxPlayer = () => ({
  socketId: null, roundWins: 0, stamina: 100,
  knockdowns: 0, roundKnockdowns: 0,
  charging: false, chargeLevel: 0, chargeTimer: null, chargeStart: null,
  comboCount: 0, comboTimes: [], lastTapTime: null, blocking: false,
});

let bx = {
  phase: 'idle', countdown: BX_COUNTDOWN, round: 1,
  timeLeft: BX_ROUND_DURATION, roundWinner: null, matchWinner: null, paused: false,
  p1: makeBxPlayer(), p2: makeBxPlayer(),
};
let bxGameTimer = null, bxCdTimer = null, bxPauseTimer = null;
let bxP1ChargeInterval = null, bxP2ChargeInterval = null;

const bxSnap = () => ({
  game: 'bx', phase: bx.phase, countdown: bx.countdown, round: bx.round,
  timeLeft: bx.timeLeft, roundWinner: bx.roundWinner, matchWinner: bx.matchWinner,
  p1Stamina: Math.max(0, Math.round(bx.p1.stamina)),
  p2Stamina: Math.max(0, Math.round(bx.p2.stamina)),
  p1Knockdowns: bx.p1.roundKnockdowns, p2Knockdowns: bx.p2.roundKnockdowns,
  p1RoundWins: bx.p1.roundWins, p2RoundWins: bx.p2.roundWins,
  p1Charging: bx.p1.charging, p2Charging: bx.p2.charging,
  p1ChargeLevel: Math.round(bx.p1.chargeLevel), p2ChargeLevel: Math.round(bx.p2.chargeLevel),
  p1ComboCount: bx.p1.comboCount, p2ComboCount: bx.p2.comboCount,
  p1Blocking: bx.p1.blocking, p2Blocking: bx.p2.blocking,
});

const bxComboMult = (count) => count >= BX_COMBO_THRESH_2 ? 2.0 : count >= BX_COMBO_THRESH_1 ? 1.5 : 1.0;

const bxRecordJab = (player) => {
  const now = Date.now();
  player.comboTimes = player.comboTimes.filter(t => now - t < BX_COMBO_WINDOW);
  player.comboTimes.push(now);
  player.comboCount = player.comboTimes.length;
  player.lastTapTime = now;
  return player.comboCount;
};

const bxIsBlock = () => {
  const t1 = bx.p1.lastTapTime, t2 = bx.p2.lastTapTime;
  if (!t1 || !t2) return false;
  return Math.abs(t1 - t2) <= BX_BLOCK_WINDOW;
};

const bxDealDamage = (io, attacker, target, targetKey, damage, eventName) => {
  target.stamina = Math.max(0, target.stamina - damage);
  io.emit('gameState', { ...bxSnap(), event: eventName, who: targetKey });
  if (target.stamina <= 0) { bxKnockdown(io, targetKey); return true; }
  return false;
};

const bxKnockdown = (io, loserKey) => {
  if (bx.paused) return;
  bx.paused = true;
  const loser = bx[loserKey];
  loser.knockdowns++; loser.roundKnockdowns++;
  loser.stamina = 100;
  clearInterval(bxGameTimer); bxGameTimer = null;
  io.emit('gameState', { ...bxSnap(), event: 'knockdown', who: loserKey });
  console.log(`🥊 KNOCKDOWN! ${loserKey.toUpperCase()} is down! (KD: ${loser.roundKnockdowns})`);
  if (bxPauseTimer) clearTimeout(bxPauseTimer);
  bxPauseTimer = setTimeout(() => { bx.paused = false; if (bx.phase === 'playing') bxResumeTimer(io); }, BX_KNOCKDOWN_PAUSE);
};

const bxResumeTimer = (io) => {
  io.emit('gameState', bxSnap());
  bxGameTimer = setInterval(() => {
    if (bx.paused) return;
    bx.timeLeft--; io.emit('gameState', bxSnap());
    if (bx.timeLeft <= 0) { clearInterval(bxGameTimer); bxGameTimer = null; bxEndRound(io); }
  }, 1000);
};

const bxEndRound = (io) => {
  clearInterval(bxGameTimer); bxGameTimer = null;
  if (bxPauseTimer) clearTimeout(bxPauseTimer);
  const kd1 = bx.p1.roundKnockdowns, kd2 = bx.p2.roundKnockdowns;
  let rw;
  if (kd1 > kd2)      rw = 'p2';
  else if (kd2 > kd1) rw = 'p1';
  else if (bx.p1.stamina > bx.p2.stamina) rw = 'p1';
  else if (bx.p2.stamina > bx.p1.stamina) rw = 'p2';
  else rw = 'tie';
  bx.roundWinner = rw; bx.phase = 'roundOver';
  if (rw !== 'tie') bx[rw].roundWins++;
  if (bx.p1.roundWins >= BX_ROUNDS_WIN) {
    bx.phase = 'finished'; bx.matchWinner = 'p1'; io.emit('gameState', bxSnap());
  } else if (bx.p2.roundWins >= BX_ROUNDS_WIN) {
    bx.phase = 'finished'; bx.matchWinner = 'p2'; io.emit('gameState', bxSnap());
  } else if (bx.round >= BX_ROUNDS) {
    bx.matchWinner = bx.p1.roundWins > bx.p2.roundWins ? 'p1' : bx.p2.roundWins > bx.p1.roundWins ? 'p2' : 'tie';
    bx.phase = 'finished'; io.emit('gameState', bxSnap());
  } else {
    io.emit('gameState', bxSnap());
    setTimeout(() => { bx.round++; bxStartCountdown(io); }, 3000);
  }
};

const bxReset = (io) => {
  clearInterval(bxGameTimer); clearInterval(bxCdTimer);
  if (bxPauseTimer) clearTimeout(bxPauseTimer);
  if (bxP1ChargeInterval) clearInterval(bxP1ChargeInterval);
  if (bxP2ChargeInterval) clearInterval(bxP2ChargeInterval);
  bx = { phase: 'idle', countdown: BX_COUNTDOWN, round: 1, timeLeft: BX_ROUND_DURATION, roundWinner: null, matchWinner: null, paused: false, p1: makeBxPlayer(), p2: makeBxPlayer() };
  io.emit('gameState', bxSnap());
};

const bxStartCountdown = (io) => {
  if (bx.phase !== 'idle' && bx.phase !== 'roundOver') return;
  const p1w = bx.p1.roundWins, p2w = bx.p2.roundWins, r = bx.round;
  bx.phase = 'countdown'; bx.countdown = BX_COUNTDOWN; bx.timeLeft = BX_ROUND_DURATION; bx.roundWinner = null; bx.paused = false;
  const p1 = makeBxPlayer(); p1.roundWins = p1w;
  const p2 = makeBxPlayer(); p2.roundWins = p2w;
  bx.p1 = p1; bx.p2 = p2; bx.round = r;
  io.emit('gameState', bxSnap());
  bxCdTimer = setInterval(() => {
    bx.countdown--;
    if (bx.countdown <= 0) { clearInterval(bxCdTimer); bxStartPlaying(io); }
    else io.emit('gameState', bxSnap());
  }, 1000);
};

const bxStartPlaying = (io) => {
  bx.phase = 'playing'; bx.timeLeft = BX_ROUND_DURATION;
  io.emit('gameState', bxSnap());
  console.log(`🥊 Boxing Round ${bx.round} — FIGHT!`);
  bxResumeTimer(io);
};

// ══════════════════════════════════════════════════════════════════════════════
// LOBBY STATE
// ══════════════════════════════════════════════════════════════════════════════
let lobbyGame = 'fft'; // 'fft' | 'war' | 'ep' | 'ed' | 'bx'
const lobbySnap = () => ({ lobby: true, selectedGame: lobbyGame });

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET HANDLERS
// ══════════════════════════════════════════════════════════════════════════════
const initializeGame = (io) => {
  io.on('connection', (socket) => {

    socket.on('selectGame', ({ game }) => {
      if (!['fft','war','ep','ed','bx'].includes(game)) return;
      const busy = (g) => g.phase !== 'idle' && g.phase !== 'finished';
      if (busy(fft) || busy(tw) || busy(ep) || busy(ed) || busy(bx)) return;
      lobbyGame = game;
      io.emit('lobbyState', lobbySnap());
      console.log(`🎮 Game selected: ${game}`);
    });

    socket.on('getLobbyState', () => socket.emit('lobbyState', lobbySnap()));

    socket.on('getGameState', () => {
      socket.emit('lobbyState', lobbySnap());
      const snaps = { fft: fftSnap, war: twSnap, ep: epSnap, ed: edSnap, bx: bxSnap };
      socket.emit('gameState', (snaps[lobbyGame] || bxSnap)());
    });

    // ══ FAST FINGER TAP ═══════════════════════════════════════════════════

    socket.on('fft_tap', ({ role }) => {
      if (fft.phase !== 'playing' && fft.phase !== 'suddenDeath') return;
      if (role !== 'p1' && role !== 'p2') return;
      const player = fft[role];
      if (player.frozen) return;
      player.score += player.comboActive ? FFT_COMBO_MULT : 1;
      if (fft.phase === 'playing') fftRecordTap(io, player, role);
      if (fft.phase === 'suddenDeath') { clearInterval(fftGameTimer); fftEndRound(io); return; }
      io.emit('gameState', fftSnap());
    });

    socket.on('fft_freeze', ({ role }) => {
      if (fft.phase !== 'playing' || (role !== 'p1' && role !== 'p2')) return;
      const attacker = fft[role];
      if (attacker.freezeUsed) return;
      attacker.freezeUsed = true;
      fftFreeze(io, fft[role === 'p1' ? 'p2' : 'p1'], role === 'p1' ? 'p2' : 'p1');
    });

    socket.on('fft_start', () => { if (fft.phase === 'idle')     fftStartCountdown(io); });
    socket.on('fft_reset', () => { if (fft.phase === 'finished') fftReset(io); });

    // ══ TAP WAR ═══════════════════════════════════════════════════════════

    socket.on('war_tap', ({ role }) => {
      if (tw.phase !== 'playing' || (role !== 'p1' && role !== 'p2')) return;
      const player = tw[role];
      let units = 1;
      if (player.surgeActive) {
        units = TW_SURGE_MULT; player.surgeCount++;
        if (player.surgeCount >= TW_SURGE_TAPS) { player.surgeActive = false; player.surgeCount = 0; }
      } else { twRecordTap(io, player, role); }
      tw.barPos = Math.max(-TW_WIN_THRESHOLD, Math.min(TW_WIN_THRESHOLD, tw.barPos + (role === 'p1' ? -units : units)));
      io.emit('gameState', twSnap());
      if (tw.barPos <= -TW_WIN_THRESHOLD) twEndRound(io, 'p1');
      else if (tw.barPos >= TW_WIN_THRESHOLD) twEndRound(io, 'p2');
    });

    socket.on('war_taunt', ({ role }) => {
      if (tw.phase !== 'playing' || (role !== 'p1' && role !== 'p2')) return;
      const attacker = tw[role];
      if (attacker.tauntUsed) return;
      attacker.tauntUsed = true;
      tw.barPos = Math.max(-TW_WIN_THRESHOLD, Math.min(TW_WIN_THRESHOLD, tw.barPos + (role === 'p1' ? -TW_TAUNT_BOUNCE : TW_TAUNT_BOUNCE)));
      io.emit('gameState', { ...twSnap(), event: 'taunt', who: role });
    });

    socket.on('war_start', () => { if (tw.phase === 'idle')     twStartCountdown(io); });
    socket.on('war_reset', () => { if (tw.phase === 'finished') twReset(io); });

    // ══ ENGINE POWER ══════════════════════════════════════════════════════

    socket.on('ep_tap', ({ role }) => {
      if (ep.phase !== 'playing' || (role !== 'p1' && role !== 'p2')) return;
      const player = ep[role];
      if (player.stalled) return;
      player.heat = Math.min(100, player.heat + EP_HEAT_PER_TAP);
      io.emit('gameState', epSnap());
    });

    socket.on('ep_vent', ({ role }) => {
      if (ep.phase !== 'playing' || (role !== 'p1' && role !== 'p2')) return;
      const attacker = ep[role];
      if (attacker.ventUsed) return;
      attacker.ventUsed = true;
      const tk = role === 'p1' ? 'p2' : 'p1';
      ep[tk].heat = Math.min(100, ep[tk].heat + EP_VENT_HEAT_SPIKE);
      io.emit('gameState', { ...epSnap(), event: 'vent', who: role });
    });

    socket.on('ep_start', () => { if (ep.phase === 'idle')     epStartCountdown(io); });
    socket.on('ep_reset', () => { if (ep.phase === 'finished') epReset(io); });

    // ══ ELECTRIC DUEL ═════════════════════════════════════════════════════

    socket.on('ed_tap', ({ role }) => {
      if (ed.phase !== 'playing' || (role !== 'p1' && role !== 'p2') || ed.isFiring) return;
      const player = ed[role];
      player.tapCount++; ed.totalTaps++;
      ed.ballCharge = Math.min(100, ed.ballCharge + ED_CHARGE_PER_TAP);
      const p1r = ed.p1.tapCount / Math.max(ed.totalTaps, 1);
      const p2r = ed.p2.tapCount / Math.max(ed.totalTaps, 1);
      ed.ballOwner = Math.max(-80, Math.min(80, (p1r - p2r) * 100 * -1));
      io.emit('gameState', edSnap());
      if (ed.ballCharge >= 100) edFire(io);
    });

    socket.on('ed_absorb', ({ role }) => {
      if (ed.phase !== 'playing' || (role !== 'p1' && role !== 'p2')) return;
      const player = ed[role];
      if (player.absorbUsed) return;
      player.absorbUsed = true; player.absorbActive = true;
      io.emit('gameState', { ...edSnap(), event: 'shieldUp', who: role });
    });

    socket.on('ed_start', () => { if (ed.phase === 'idle')     edStartCountdown(io); });
    socket.on('ed_reset', () => { if (ed.phase === 'finished') edReset(io); });

    // ══ BOXING MATCH ══════════════════════════════════════════════════════

    socket.on('bx_jab', ({ role }) => {
      if (bx.phase !== 'playing' || bx.paused || (role !== 'p1' && role !== 'p2')) return;
      const attacker  = bx[role];
      const targetKey = role === 'p1' ? 'p2' : 'p1';
      const target    = bx[targetKey];

      attacker.lastTapTime = Date.now();

      // Block check — simultaneous tap
      if (bxIsBlock()) {
        attacker.blocking = true; target.blocking = true;
        attacker.comboCount = 0; attacker.comboTimes = [];
        target.comboCount = 0;   target.comboTimes = [];
        io.emit('gameState', { ...bxSnap(), event: 'block', who: role });
        console.log(`🛡  BLOCK!`);
        return;
      }

      const combo  = bxRecordJab(attacker);
      const damage = Math.round(BX_JAB_DAMAGE * bxComboMult(combo));
      bxDealDamage(io, attacker, target, targetKey, damage, 'jab');
      console.log(`👊 ${role.toUpperCase()} jabs for ${damage} dmg (combo:${combo})`);
    });

    socket.on('bx_charge_start', ({ role }) => {
      if (bx.phase !== 'playing' || bx.paused || (role !== 'p1' && role !== 'p2')) return;
      const player = bx[role];
      if (player.charging) return;
      player.charging = true; player.chargeLevel = 0; player.chargeStart = Date.now();
      player.comboCount = 0; player.comboTimes = [];

      if (role === 'p1') {
        if (bxP1ChargeInterval) clearInterval(bxP1ChargeInterval);
        bxP1ChargeInterval = setInterval(() => {
          if (!bx.p1.charging) { clearInterval(bxP1ChargeInterval); return; }
          bx.p1.chargeLevel = Math.min(100, ((Date.now() - bx.p1.chargeStart) / BX_CHARGE_TIME) * 100);
          io.emit('gameState', bxSnap());
        }, 80);
      } else {
        if (bxP2ChargeInterval) clearInterval(bxP2ChargeInterval);
        bxP2ChargeInterval = setInterval(() => {
          if (!bx.p2.charging) { clearInterval(bxP2ChargeInterval); return; }
          bx.p2.chargeLevel = Math.min(100, ((Date.now() - bx.p2.chargeStart) / BX_CHARGE_TIME) * 100);
          io.emit('gameState', bxSnap());
        }, 80);
      }
      io.emit('gameState', bxSnap());
    });

    socket.on('bx_charge_release', ({ role }) => {
      if (role !== 'p1' && role !== 'p2') return;
      const player    = bx[role];
      const targetKey = role === 'p1' ? 'p2' : 'p1';
      const target    = bx[targetKey];
      if (!player.charging) return;

      if (role === 'p1') clearInterval(bxP1ChargeInterval);
      else               clearInterval(bxP2ChargeInterval);

      const held = player.chargeStart ? Date.now() - player.chargeStart : 0;
      player.charging = false; player.chargeLevel = 0; player.chargeStart = null;

      if (bx.phase !== 'playing' || bx.paused) { io.emit('gameState', bxSnap()); return; }

      player.lastTapTime = Date.now();

      if (held >= BX_CHARGE_TIME) {
        // Full heavy punch
        bxDealDamage(io, player, target, targetKey, BX_HEAVY_DAMAGE, 'heavy');
        console.log(`💥 ${role.toUpperCase()} HEAVY PUNCH for ${BX_HEAVY_DAMAGE} dmg`);
      } else {
        // Early release = jab
        if (bxIsBlock()) {
          player.blocking = true; target.blocking = true;
          io.emit('gameState', { ...bxSnap(), event: 'block', who: role });
        } else {
          const combo  = bxRecordJab(player);
          const damage = Math.round(BX_JAB_DAMAGE * bxComboMult(combo));
          bxDealDamage(io, player, target, targetKey, damage, 'jab');
        }
      }
    });

    socket.on('bx_start', () => { if (bx.phase === 'idle')     bxStartCountdown(io); });
    socket.on('bx_reset', () => { if (bx.phase === 'finished') bxReset(io); });

  });

  console.log('🎮 Games: Fast Finger Tap + Tap War + Engine Power + Electric Duel + Boxing Match');
};

module.exports = { initializeGame };