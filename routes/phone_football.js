// ─────────────────────────────────────────────────────────────────────────────
// routes/phone_football.js  —  v2
// NEW: pf_move (trackpad movement), solo practice mode, wider pitch,
//      cross/header/press/intercept actions, stamina system
// ─────────────────────────────────────────────────────────────────────────────

let _nanoid;
try { _nanoid = require('nanoid').nanoid; } catch (e) { _nanoid = null; }
function generateRoomId() {
  if (_nanoid) return _nanoid(6).toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = ''; for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const PF_MAX_PLAYERS     = 6;
const PF_MATCH_SECS      = 120;
const PF_TICK_MS         = 80;          // ~12.5fps physics
const PF_COUNTDOWN_SECS  = 3;
const PF_PITCH_W         = 140;         // WIDER pitch (was 100)
const PF_PITCH_H         = 70;          // TALLER pitch (was 60)
const PF_GOAL_Y_MIN      = 27;
const PF_GOAL_Y_MAX      = 43;
const PF_PLAYER_SPEED    = 4.2;
const PF_SPRINT_MULT     = 1.75;
const PF_BALL_PASS_SPEED = 10;
const PF_BALL_CROSS_SPEED= 12;
const PF_BALL_SHOOT_SPEED= 16;
const PF_BALL_FRICTION   = 0.90;
const PF_TACKLE_RANGE    = 9;
const PF_PASS_RANGE      = 50;
const PF_STAMINA_MAX     = 100;
const PF_STAMINA_SPRINT  = -18;   // per sprint action
const PF_STAMINA_REGEN   = 0.8;   // per tick

const TEAM_COLORS = ['red','blue','green','yellow','purple','orange'];
const TEAM_NAMES  = ['REDS','BLUES','GREENS','YELLOWS','PURPLES','ORANGES'];

// Wider pitch starting positions
const START_POS_A = [[28,22],[28,48],[38,35]];
const START_POS_B = [[112,22],[112,48],[102,35]];

// ─── AI DIFFICULTY TIERS ─────────────────────────────────────────────────────
const AI_MOVE_SPEED_MULT = 0.72;  // AI is slightly slower than max player speed
const AI_SHOOT_DIST      = 35;    // max dist to attempt shot
const AI_REACTION_MS     = 600;   // AI reacts every N ms

// ─── ROOM STORE ──────────────────────────────────────────────────────────────
const pfRooms = new Map();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dist(ax, ay, bx, by) { return Math.sqrt((ax-bx)**2 + (ay-by)**2); }
function rand(min, max) { return min + Math.random() * (max - min); }

function createPfPlayer(name, socketId, teamId, slot, isHost = false, isAI = false) {
  const pos = teamId === 'A' ? START_POS_A[slot] : START_POS_B[slot];
  return {
    id: socketId, name, socketId, teamId, slot, isHost, isAI,
    x: pos[0], y: pos[1], vx: 0, vy: 0,
    hasBall: false, sprintActive: false,
    goals: 0, tackles: 0, passes: 0, shots: 0,
    lastAction: 0,
    stamina: PF_STAMINA_MAX,
    // Input from trackpad (set by pf_move)
    inputDx: 0, inputDy: 0,
    // AI state
    aiTarget: null, aiLastThink: 0,
  };
}

function createRoom(hostName, hostSocketId, soloMode = false) {
  const roomId = generateRoomId();
  const host = createPfPlayer(hostName, hostSocketId, 'A', 0, true);
  const room = {
    roomId, phase: 'lobby', soloMode,
    players: new Map([[hostSocketId, host]]),
    teamA: { id: 'A', name: TEAM_NAMES[0], color: TEAM_COLORS[0], score: 0 },
    teamB: { id: 'B', name: TEAM_NAMES[1], color: TEAM_COLORS[1], score: 0 },
    ball: { x: 70, y: 35, vx: 0, vy: 0, ownerId: null },
    timeLeft: PF_MATCH_SECS,
    half: 1,
    tickInterval: null, countdownInterval: null, halfTimer: null,
    countdown: PF_COUNTDOWN_SECS,
    createdAt: Date.now(),
    lastGoalTime: 0,
  };
  pfRooms.set(roomId, room);
  return { roomId, room };
}

function addAIPlayers(room) {
  // Add AI for team B (3 players) and optionally fill team A gaps
  const aCount = [...room.players.values()].filter(p => p.teamId === 'A').length;
  const bCount = [...room.players.values()].filter(p => p.teamId === 'B').length;

  // Fill team B with AI
  for (let i = bCount; i < 3; i++) {
    const aiId = `ai_b_${i}_${Date.now()}`;
    const ai   = createPfPlayer(`AI-${i+1}`, aiId, 'B', i, false, true);
    room.players.set(aiId, ai);
  }
  // Fill team A gaps too if solo
  for (let i = aCount; i < 3; i++) {
    const aiId = `ai_a_${i}_${Date.now()}`;
    const ai   = createPfPlayer(`BOT-${i+1}`, aiId, 'A', i, false, true);
    room.players.set(aiId, ai);
  }
  console.log(`🤖 Added AI players to room ${room.roomId}`);
}

function destroyRoom(roomId) {
  const room = pfRooms.get(roomId);
  if (!room) return;
  clearInterval(room.tickInterval);
  clearInterval(room.countdownInterval);
  clearTimeout(room.halfTimer);
  pfRooms.delete(roomId);
}

function getRoomOfSocket(socketId) {
  for (const [roomId, room] of pfRooms) {
    if (room.players.has(socketId)) return { roomId, room };
  }
  return null;
}

function buildLobbyState(room) {
  return {
    roomId: room.roomId, phase: room.phase, soloMode: room.soloMode,
    players: [...room.players.values()].filter(p => !p.isAI).map(p => ({
      id: p.id, name: p.name, team: p.teamId, isHost: p.isHost,
      hasBall: p.hasBall, goals: p.goals,
    })),
    teams: [
      { id: 'A', name: room.teamA.name, color: room.teamA.color, score: room.teamA.score,
        players: [...room.players.values()].filter(p => p.teamId === 'A' && !p.isAI).map(p => p.name) },
      { id: 'B', name: room.teamB.name, color: room.teamB.color, score: room.teamB.score,
        players: [...room.players.values()].filter(p => p.teamId === 'B' && !p.isAI).map(p => p.name) },
    ],
  };
}

function buildGameState(room) {
  return {
    roomId: room.roomId, phase: room.phase,
    timeLeft: room.timeLeft, half: room.half, soloMode: room.soloMode,
    pitchW: PF_PITCH_W, pitchH: PF_PITCH_H,
    scores: { A: room.teamA.score, B: room.teamB.score },
    ball: { x: room.ball.x, y: room.ball.y, ownerId: room.ball.ownerId },
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.teamId,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      hasBall: p.hasBall, sprintActive: p.sprintActive,
      goals: p.goals, tackles: p.tackles, passes: p.passes,
      stamina: p.stamina, isAI: p.isAI,
    })),
    teamA: room.teamA, teamB: room.teamB,
  };
}

// ─── AI LOGIC ─────────────────────────────────────────────────────────────────
function tickAI(io, room, p) {
  const ball = room.ball;
  const now  = Date.now();

  if (now - p.aiLastThink < AI_REACTION_MS) return;
  p.aiLastThink = now;

  const isAttacker  = p.slot === 2;
  const isMidfield  = p.slot === 1;
  const isDefender  = p.slot === 0;
  const enemyTeam   = p.teamId === 'A' ? 'B' : 'A';
  const goalX       = p.teamId === 'A' ? PF_PITCH_W - 2 : 2;
  const goalY       = PF_PITCH_H / 2;

  // Home position (return here when not active)
  const homePosA = START_POS_A[p.slot];
  const homePosB = START_POS_B[p.slot];
  const homePos  = p.teamId === 'A' ? homePosA : homePosB;

  if (p.hasBall) {
    // AI has ball — decide: shoot or pass?
    const dToGoal = dist(p.x, p.y, goalX, goalY);
    if (dToGoal < AI_SHOOT_DIST && Math.random() > 0.4) {
      // Shoot!
      const dx = goalX - ball.x;
      const dy = goalY - ball.y + rand(-5, 5);
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      p.hasBall = false; ball.ownerId = null;
      ball.vx = (dx/d) * PF_BALL_SHOOT_SPEED;
      ball.vy = (dy/d) * PF_BALL_SHOOT_SPEED;
      p.shots++;
      io.to(room.roomId).emit('pf_shot', { playerId: p.id, name: p.name, team: p.teamId });
    } else {
      // Dribble toward goal
      const dx = goalX - p.x; const dy = goalY - p.y;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      const spd = PF_PLAYER_SPEED * AI_MOVE_SPEED_MULT;
      p.inputDx = (dx/d); p.inputDy = (dy/d);
    }
  } else {
    // No ball — move toward it if close enough to role
    const dToBall = dist(p.x, p.y, ball.x, ball.y);
    const shouldChase = isAttacker || (isMidfield && dToBall < 40) || (isDefender && dToBall < 25);

    if (shouldChase) {
      const dx = ball.x - p.x; const dy = ball.y - p.y;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      p.inputDx = dx/d; p.inputDy = dy/d;
      // Attempt tackle if close
      if (dToBall < PF_TACKLE_RANGE) {
        const owner = room.players.get(ball.ownerId);
        if (owner && owner.teamId !== p.teamId && Math.random() > 0.5) {
          owner.hasBall = false; ball.ownerId = null;
          ball.vx = rand(-3,3); ball.vy = rand(-3,3);
          p.tackles++;
          io.to(room.roomId).emit('pf_tackle_event', { tackler: p.name, tackled: owner.name });
        }
      }
    } else {
      // Drift toward home position
      const dx = homePos[0] - p.x; const dy = homePos[1] - p.y;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      p.inputDx = d > 5 ? dx/d * 0.5 : 0;
      p.inputDy = d > 5 ? dy/d * 0.5 : 0;
    }
  }
}

// ─── PHYSICS ─────────────────────────────────────────────────────────────────
function resetPositions(room) {
  let slotA = 0, slotB = 0;
  room.players.forEach(p => {
    if (p.teamId === 'A') {
      const pos = START_POS_A[slotA % 3];
      p.x = pos[0]; p.y = pos[1]; p.vx = 0; p.vy = 0;
      p.hasBall = false; p.inputDx = 0; p.inputDy = 0; slotA++;
    } else {
      const pos = START_POS_B[slotB % 3];
      p.x = pos[0]; p.y = pos[1]; p.vx = 0; p.vy = 0;
      p.hasBall = false; p.inputDx = 0; p.inputDy = 0; slotB++;
    }
  });
  room.ball = { x: PF_PITCH_W / 2, y: PF_PITCH_H / 2, vx: 0, vy: 0, ownerId: null };
}

function tickPhysics(io, room) {
  const ball = room.ball;
  const now  = Date.now();

  // AI think
  room.players.forEach(p => { if (p.isAI) tickAI(io, room, p); });

  // Move players based on input (trackpad dx/dy)
  room.players.forEach(p => {
    const mag = Math.sqrt(p.inputDx**2 + p.inputDy**2);
    if (mag > 0.05) {
      const spd = (p.sprintActive && p.stamina > 10)
        ? PF_PLAYER_SPEED * PF_SPRINT_MULT
        : PF_PLAYER_SPEED;
      p.vx = (p.inputDx / Math.max(mag, 1)) * spd * 0.55;
      p.vy = (p.inputDy / Math.max(mag, 1)) * spd * 0.55;
    }

    p.x = clamp(p.x + p.vx, 2, PF_PITCH_W - 2);
    p.y = clamp(p.y + p.vy, 2, PF_PITCH_H - 2);
    p.vx *= 0.82; p.vy *= 0.82;

    // Stamina
    if (p.sprintActive && !p.isAI) p.stamina = Math.max(0, p.stamina - 0.3);
    else p.stamina = Math.min(PF_STAMINA_MAX, p.stamina + PF_STAMINA_REGEN);

    // Drag ball with owner
    if (p.hasBall) {
      ball.x = p.x + (p.teamId === 'A' ? 2.5 : -2.5);
      ball.y = p.y;
      ball.vx = 0; ball.vy = 0;
      ball.ownerId = p.id;
    }
  });

  // Move free ball
  if (!ball.ownerId) {
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.vx *= PF_BALL_FRICTION;
    ball.vy *= PF_BALL_FRICTION;

    // Wall bounce
    if (ball.y <= 1)              { ball.y = 1;               ball.vy *= -0.65; }
    if (ball.y >= PF_PITCH_H - 1) { ball.y = PF_PITCH_H - 1; ball.vy *= -0.65; }

    // Left wall / left goal
    if (ball.x <= 0) {
      if (ball.y >= PF_GOAL_Y_MIN && ball.y <= PF_GOAL_Y_MAX) {
        scoreGoal(io, room, 'B', null);
        return;
      }
      ball.x = 1; ball.vx *= -0.6;
    }
    // Right wall / right goal
    if (ball.x >= PF_PITCH_W) {
      if (ball.y >= PF_GOAL_Y_MIN && ball.y <= PF_GOAL_Y_MAX) {
        scoreGoal(io, room, 'A', null);
        return;
      }
      ball.x = PF_PITCH_W - 1; ball.vx *= -0.6;
    }

    // Auto pickup
    let closest = null; let closestDist = 5.5;
    room.players.forEach(p => {
      const d = dist(p.x, p.y, ball.x, ball.y);
      if (d < closestDist) { closestDist = d; closest = p; }
    });
    if (closest) {
      closest.hasBall = true;
      ball.ownerId = closest.id;
      if (!closest.isAI) {
        io.to(closest.socketId).emit('pf_you_have_ball', {});
      }
      io.to(room.roomId).emit('pf_ball_pickup', {
        playerId: closest.id, name: closest.name, team: closest.teamId,
      });
    }
  }

  // Validate ownership
  if (ball.ownerId) {
    const owner = room.players.get(ball.ownerId);
    if (!owner || !owner.hasBall) { ball.ownerId = null; }
  }
}

function scoreGoal(io, room, teamId, scorerId) {
  if (room.phase !== 'playing') return;
  const now = Date.now();
  if (now - room.lastGoalTime < 2000) return;
  room.lastGoalTime = now;

  if (teamId === 'A') room.teamA.score++;
  else room.teamB.score++;

  const scorer = scorerId ? room.players.get(scorerId) : null;
  if (scorer) scorer.goals++;

  io.to(room.roomId).emit('pf_goal', {
    team: teamId,
    scorer: scorer ? scorer.name : null,
    scoreA: room.teamA.score,
    scoreB: room.teamB.score,
  });

  room.players.forEach(p => {
    if (!p.isAI) io.to(p.socketId).emit('pf_goal', {
      team: teamId, scorer: scorer?.name,
      scoreA: room.teamA.score, scoreB: room.teamB.score,
    });
  });

  setTimeout(() => {
    if (room.phase === 'playing') {
      resetPositions(room);
      io.to(room.roomId).emit('pf_tick', buildGameState(room));
    }
  }, 2500);
}

// ─── GAME FLOW ────────────────────────────────────────────────────────────────
function startCountdown(io, room) {
  room.phase = 'countdown';
  room.countdown = PF_COUNTDOWN_SECS;
  io.to(room.roomId).emit('pf_countdown', { countdown: room.countdown });
  room.countdownInterval = setInterval(() => {
    room.countdown--;
    if (room.countdown > 0) {
      io.to(room.roomId).emit('pf_countdown', { countdown: room.countdown });
    } else {
      clearInterval(room.countdownInterval);
      startMatch(io, room);
    }
  }, 1000);
}

function startMatch(io, room) {
  room.phase = 'playing';
  room.timeLeft = room.soloMode ? 99999 : PF_MATCH_SECS; // unlimited in solo
  room.half = 1;
  room.teamA.score = 0; room.teamB.score = 0;
  resetPositions(room);
  io.to(room.roomId).emit('pf_game_start', buildGameState(room));
  startTick(io, room);
  if (!room.soloMode) startMatchTimer(io, room);
}

function startMatchTimer(io, room) {
  clearInterval(room.halfTimer);
  room.halfTimer = setInterval(() => {
    if (room.phase !== 'playing') { clearInterval(room.halfTimer); return; }
    room.timeLeft--;
    if (room.timeLeft <= 0) {
      clearInterval(room.halfTimer);
      room.half === 1 ? startHalftime(io, room) : endMatch(io, room);
    }
  }, 1000);
}

function startHalftime(io, room) {
  clearInterval(room.tickInterval);
  room.phase = 'halftime';
  io.to(room.roomId).emit('pf_halftime', { scoreA: room.teamA.score, scoreB: room.teamB.score });
  setTimeout(() => {
    if (room.phase !== 'halftime') return;
    room.phase = 'playing'; room.half = 2;
    room.timeLeft = PF_MATCH_SECS;
    resetPositions(room);
    io.to(room.roomId).emit('pf_second_half', buildGameState(room));
    startTick(io, room);
    startMatchTimer(io, room);
  }, 8000);
}

function startTick(io, room) {
  clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => {
    if (room.phase !== 'playing') { clearInterval(room.tickInterval); return; }
    tickPhysics(io, room);
    io.to(room.roomId).emit('pf_tick', buildGameState(room));
  }, PF_TICK_MS);
}

function endMatch(io, room) {
  clearInterval(room.tickInterval);
  clearInterval(room.halfTimer);
  room.phase = 'finished';
  let winner = 'draw';
  if (room.teamA.score > room.teamB.score) winner = 'A';
  else if (room.teamB.score > room.teamA.score) winner = 'B';
  io.to(room.roomId).emit('pf_finished', {
    winner,
    scoreA: room.teamA.score, scoreB: room.teamB.score,
    teamA: room.teamA, teamB: room.teamB,
    players: [...room.players.values()].filter(p => !p.isAI).map(p => ({
      id: p.id, name: p.name, team: p.teamId,
      goals: p.goals, tackles: p.tackles, passes: p.passes,
    })),
  });
}

function handleLeave(io, socket, roomId) {
  const room = pfRooms.get(roomId);
  if (!room) return;
  const player = room.players.get(socket.id);
  if (!player) return;
  room.players.delete(socket.id);
  socket.leave(roomId);
  const humanPlayers = [...room.players.values()].filter(p => !p.isAI);
  if (humanPlayers.length === 0) { destroyRoom(roomId); return; }
  if (player.isHost) {
    const next = humanPlayers[0];
    if (next) { next.isHost = true; io.to(next.socketId).emit('pf_you_are_host', {}); }
  }
  io.to(roomId).emit('pf_player_left', { playerId: socket.id, name: player.name });
  if (room.phase === 'lobby') io.to(roomId).emit('pf_lobby', buildLobbyState(room));
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
function initializePhoneFootball(io, socket) {

  // ── CREATE ROOM ────────────────────────────────────────────────────────────
  socket.on('pf_create_room', ({ name, soloMode = false }) => {
    if (!name || typeof name !== 'string') return;
    const { roomId, room } = createRoom(name.trim().slice(0, 20), socket.id, soloMode);
    socket.join(roomId);
    socket.emit('pf_room_created', { roomId, playerId: socket.id, isHost: true });
    io.to(roomId).emit('pf_lobby', buildLobbyState(room));
    console.log(`⚽ PF room created: ${roomId} by ${name}${soloMode ? ' [SOLO]' : ''}`);
  });

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
  socket.on('pf_join_room', ({ name, roomId }) => {
    if (!name || !roomId) return;
    const isSpectator = typeof name === 'string' && name.startsWith('_DASH_');
    const cleanId = roomId.toUpperCase().trim();
    const room = pfRooms.get(cleanId);
    if (!room) { socket.emit('pf_error', { message: 'Room not found.' }); return; }

    if (!isSpectator) {
      if (room.phase !== 'lobby') { socket.emit('pf_error', { message: 'Match already started!' }); return; }
      const humanCount = [...room.players.values()].filter(p => !p.isAI).length;
      if (humanCount >= PF_MAX_PLAYERS) { socket.emit('pf_error', { message: 'Room full.' }); return; }
      const aCount = [...room.players.values()].filter(p => p.teamId === 'A' && !p.isAI).length;
      const bCount = [...room.players.values()].filter(p => p.teamId === 'B' && !p.isAI).length;
      const teamId = aCount <= bCount ? 'A' : 'B';
      const slot   = teamId === 'A' ? aCount : bCount;
      const player = createPfPlayer(name.trim().slice(0, 20), socket.id, teamId, slot);
      room.players.set(socket.id, player);
      console.log(`👤 PF ${name} joined room ${room.roomId} team ${teamId}`);
    } else {
      console.log(`👁️  Dashboard spectator joined ${cleanId}`);
    }

    socket.join(room.roomId);
    socket.emit('pf_joined', { roomId: room.roomId, playerId: socket.id, isHost: false });

    if (!isSpectator) {
      io.to(room.roomId).emit('pf_lobby', buildLobbyState(room));
    } else {
      if (room.phase === 'lobby')   socket.emit('pf_lobby', buildLobbyState(room));
      if (room.phase === 'playing') socket.emit('pf_game_start', buildGameState(room));
      if (room.phase === 'finished') socket.emit('pf_finished', { winner: 'draw', scoreA: room.teamA.score, scoreB: room.teamB.score });
    }
  });

  // ── START GAME ─────────────────────────────────────────────────────────────
  socket.on('pf_start_game', ({ roomId }) => {
    const room = pfRooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player?.isHost) { socket.emit('pf_error', { message: 'Only host can start.' }); return; }
    if (room.phase !== 'lobby') return;
    // Add AI players if needed
    if (room.soloMode || room.players.size < 2) addAIPlayers(room);
    else {
      // Fill empty team slots with AI for balance
      const aCount = [...room.players.values()].filter(p => p.teamId === 'A' && !p.isAI).length;
      const bCount = [...room.players.values()].filter(p => p.teamId === 'B' && !p.isAI).length;
      if (bCount === 0) {
        for (let i = 0; i < 3; i++) {
          const aiId = `ai_b_${i}_${Date.now()}`;
          room.players.set(aiId, createPfPlayer(`AI-${i+1}`, aiId, 'B', i, false, true));
        }
      }
    }
    startCountdown(io, room);
  });

  // ── TRACKPAD MOVEMENT ──────────────────────────────────────────────────────
  socket.on('pf_move', ({ roomId, dx, dy }) => {
    const room = pfRooms.get(roomId);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    // Store input; physics tick applies it
    player.inputDx = clamp(dx, -1, 1);
    player.inputDy = clamp(dy, -1, 1);
  });

  // Stop moving when trackpad released
  socket.on('pf_move_stop', ({ roomId }) => {
    const room = pfRooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.inputDx = 0; player.inputDy = 0;
  });

  // ── PLAYER ACTIONS ─────────────────────────────────────────────────────────
  socket.on('pf_action', ({ roomId, action, direction }) => {
    const room = pfRooms.get(roomId);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.isAI) return;

    const now = Date.now();
    if (now - player.lastAction < 80) return;
    player.lastAction = now;

    const ball = room.ball;

    if (action === 'pass' && player.hasBall) {
      let target = null; let bestDist = PF_PASS_RANGE;
      room.players.forEach(p => {
        if (p.id === player.id || p.teamId !== player.teamId) return;
        const d = dist(player.x, player.y, p.x, p.y);
        if (d < bestDist) { bestDist = d; target = p; }
      });
      if (target) {
        player.hasBall = false; ball.ownerId = null;
        const dx = target.x - ball.x; const dy = target.y - ball.y;
        const d  = Math.sqrt(dx*dx + dy*dy) || 1;
        ball.vx = (dx/d) * PF_BALL_PASS_SPEED;
        ball.vy = (dy/d) * PF_BALL_PASS_SPEED;
        player.passes++;
        io.to(room.roomId).emit('pf_ball_passed', { from: player.id, fromName: player.name, to: target.id, toName: target.name, team: player.teamId });
      } else {
        const dirMap = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
        const dir = dirMap[direction] || (player.teamId === 'A' ? [1,0] : [-1,0]);
        player.hasBall = false; ball.ownerId = null;
        ball.vx = dir[0] * PF_BALL_PASS_SPEED;
        ball.vy = dir[1] * PF_BALL_PASS_SPEED;
        player.passes++;
        io.to(room.roomId).emit('pf_ball_passed', { from: player.id, fromName: player.name, direction });
      }

    } else if (action === 'cross' && player.hasBall) {
      // High cross to the far side
      const targetX = player.teamId === 'A' ? PF_PITCH_W * 0.8 : PF_PITCH_W * 0.2;
      const targetY = ball.y > PF_PITCH_H / 2 ? PF_PITCH_H * 0.3 : PF_PITCH_H * 0.7;
      const dx = targetX - ball.x; const dy = targetY - ball.y;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      player.hasBall = false; ball.ownerId = null;
      ball.vx = (dx/d) * PF_BALL_CROSS_SPEED;
      ball.vy = (dy/d) * PF_BALL_CROSS_SPEED;
      player.passes++;
      io.to(room.roomId).emit('pf_ball_passed', { from: player.id, fromName: player.name, type: 'cross' });

    } else if (action === 'shoot' && player.hasBall) {
      const goalX = player.teamId === 'A' ? PF_PITCH_W : 0;
      const goalY = PF_PITCH_H / 2;
      const dx = goalX - ball.x;
      const dy = goalY - ball.y + (Math.random() - 0.5) * 10;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      player.hasBall = false; ball.ownerId = null;
      ball.vx = (dx/d) * PF_BALL_SHOOT_SPEED;
      ball.vy = (dy/d) * PF_BALL_SHOOT_SPEED;
      player.shots++;
      io.to(room.roomId).emit('pf_shot', { playerId: player.id, name: player.name, team: player.teamId });

    } else if (action === 'header' || action === 'chest') {
      // Aerial challenge — redirect ball toward goal
      if (ball.ownerId && room.players.get(ball.ownerId)?.teamId !== player.teamId) {
        const dToBall = dist(player.x, player.y, ball.x, ball.y);
        if (dToBall < 12) {
          room.players.get(ball.ownerId).hasBall = false;
          ball.ownerId = null;
          const goalX = player.teamId === 'A' ? PF_PITCH_W : 0;
          const dx = goalX - ball.x; const dy = -2 + (Math.random()-0.5)*5;
          const d  = Math.sqrt(dx*dx + dy*dy)||1;
          ball.vx = (dx/d)*10; ball.vy = (dy/d)*10;
          io.to(room.roomId).emit('pf_tackle_event', { tackler: player.name, tackled: room.players.get(ball.ownerId)?.name || '?' });
        }
      } else if (!ball.ownerId) {
        const dToBall = dist(player.x, player.y, ball.x, ball.y);
        if (dToBall < 10) {
          const goalX = player.teamId === 'A' ? PF_PITCH_W : 0;
          const dx = goalX - ball.x;
          const d  = Math.abs(dx) || 1;
          ball.vx = (dx/d)*11; ball.vy = (Math.random()-0.5)*4;
          player.shots++;
          io.to(room.roomId).emit('pf_shot', { playerId: player.id, name: player.name, team: player.teamId });
        }
      }

    } else if (action === 'tackle' && !player.hasBall) {
      let tackled = null; let tDist = PF_TACKLE_RANGE;
      room.players.forEach(p => {
        if (p.teamId === player.teamId || !p.hasBall) return;
        const d = dist(player.x, player.y, p.x, p.y);
        if (d < tDist) { tDist = d; tackled = p; }
      });
      if (tackled) {
        const success = Math.random() > 0.32;
        if (success) {
          tackled.hasBall = false; ball.ownerId = null;
          ball.vx = (Math.random()-0.5)*5; ball.vy = (Math.random()-0.5)*5;
          player.tackles++;
          io.to(tackled.socketId).emit('pf_tackled', {});
          io.to(player.socketId).emit('pf_tackle_success', { tackledName: tackled.name });
          io.to(room.roomId).emit('pf_tackle_event', { tackler: player.name, tackled: tackled.name });
        }
      }

    } else if (action === 'sprint') {
      if (player.stamina > 15) {
        player.sprintActive = true;
        player.stamina = Math.max(0, player.stamina + PF_STAMINA_SPRINT);
        const dir = player.teamId === 'A' ? 1 : -1;
        player.vx += dir * PF_PLAYER_SPEED * (PF_SPRINT_MULT - 1) * 2;
        setTimeout(() => { if (room.players.has(socket.id)) player.sprintActive = false; }, 1800);
      } else {
        io.to(socket.id).emit('pf_error', { message: 'LOW STAMINA!' });
      }

    } else if (action === 'press') {
      // Find closest opponent and move toward them
      let closestOpp = null; let cDist = 25;
      room.players.forEach(p => {
        if (p.teamId === player.teamId) return;
        const d = dist(player.x, player.y, p.x, p.y);
        if (d < cDist) { cDist = d; closestOpp = p; }
      });
      if (closestOpp) {
        const dx = closestOpp.x - player.x; const dy = closestOpp.y - player.y;
        const d = Math.sqrt(dx*dx+dy*dy)||1;
        player.inputDx = dx/d; player.inputDy = dy/d;
        setTimeout(() => { if (room.players.has(socket.id)) { player.inputDx = 0; player.inputDy = 0; } }, 600);
      }

    } else if (action === 'intercept') {
      // Move to intercept ball's predicted path
      const predX = ball.x + ball.vx * 4;
      const predY = ball.y + ball.vy * 4;
      const dx = predX - player.x; const dy = predY - player.y;
      const d = Math.sqrt(dx*dx+dy*dy)||1;
      player.inputDx = dx/d; player.inputDy = dy/d;
      setTimeout(() => { if (room.players.has(socket.id)) { player.inputDx = 0; player.inputDy = 0; } }, 800);
    }
  });

  // ── RESET ──────────────────────────────────────────────────────────────────
  socket.on('pf_reset', ({ roomId }) => {
    const room = pfRooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player?.isHost) return;
    clearInterval(room.tickInterval);
    clearInterval(room.countdownInterval);
    clearInterval(room.halfTimer);
    // Remove AI players for lobby
    for (const [id, p] of room.players) {
      if (p.isAI) room.players.delete(id);
    }
    room.phase = 'lobby';
    room.teamA.score = 0; room.teamB.score = 0;
    room.half = 1; room.timeLeft = PF_MATCH_SECS;
    room.players.forEach(p => { p.goals = 0; p.tackles = 0; p.passes = 0; p.shots = 0; p.hasBall = false; p.stamina = PF_STAMINA_MAX; });
    io.to(room.roomId).emit('pf_lobby', buildLobbyState(room));
  });

  // ── LEAVE / DISCONNECT ─────────────────────────────────────────────────────
  socket.on('pf_leave', ({ roomId }) => handleLeave(io, socket, roomId));
  socket.on('disconnect', () => {
    const found = getRoomOfSocket(socket.id);
    if (found) handleLeave(io, socket, found.roomId);
  });
}

module.exports = { initializePhoneFootball };