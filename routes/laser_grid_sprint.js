// ─────────────────────────────────────────────────────────────────────────────
// routes/laser_grid_sprint.js
// ─────────────────────────────────────────────────────────────────────────────

// ── nanoid safe load (works for v3 CommonJS AND v4+ ESM) ─────────────────────
let _nanoid;
try {
  _nanoid = require('nanoid').nanoid; // nanoid@3
} catch (e) {
  _nanoid = null;
}

function generateRoomId() {
  if (_nanoid) return _nanoid(6).toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const LANE_COUNT       = 3;
const GRID_COLS        = 30;
const TICK_MS          = 80;
const SPEED_BOOST_SECS = 10;
const MAX_SPEED        = 6;
const COUNTDOWN_SECS   = 3;
const MAX_PLAYERS      = 8;

// ─── ROOM STORE ──────────────────────────────────────────────────────────────
const rooms = new Map();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function randomLaserPattern(cols, activePlayers) {
  const pattern = [];
  for (let c = 0; c < cols; c++) {
    const safeCount = Math.max(1, LANE_COUNT - Math.min(2, activePlayers - 1));
    const safeLanes = new Set();
    while (safeLanes.size < safeCount) {
      safeLanes.add(Math.floor(Math.random() * LANE_COUNT));
    }
    const col = Array.from({ length: LANE_COUNT }, (_, i) => !safeLanes.has(i));
    pattern.push(col);
  }
  return pattern;
}

function createPlayer(name, socketId, isHost = false) {
  return {
    id: socketId, name, isHost,
    lane: 1, colOffset: 0,
    alive: true, eliminated: false,
    finishTime: null, rank: null, socketId,
  };
}

function createRoom(hostName, hostSocketId) {
  const roomId = generateRoomId();
  const host   = createPlayer(hostName, hostSocketId, true);
  const room   = {
    roomId, phase: 'lobby',
    players: new Map([[hostSocketId, host]]),
    laserPattern: [], scrollOffset: 0,
    speedMultiplier: 1, countdown: COUNTDOWN_SECS,
    tickInterval: null, countdownInterval: null,
    elapsedSecs: 0, finishCount: 0,
    totalAliveAtStart: 0, createdAt: Date.now(),
  };
  rooms.set(roomId, room);
  return { roomId, host, room };
}

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearInterval(room.tickInterval);
  clearInterval(room.countdownInterval);
  rooms.delete(roomId);
}

function getRoomOfSocket(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.players.has(socketId)) return { roomId, room };
  }
  return null;
}

function buildLobbyState(room) {
  return {
    roomId: room.roomId, phase: room.phase,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, isHost: p.isHost,
    })),
  };
}

function buildGameState(room) {
  return {
    roomId: room.roomId, phase: room.phase,
    countdown: room.countdown, elapsedSecs: room.elapsedSecs,
    speed: room.speedMultiplier, scrollOffset: room.scrollOffset,
    laserPattern: room.laserPattern.slice(room.scrollOffset, room.scrollOffset + GRID_COLS),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, lane: p.lane,
      colOffset: p.colOffset, alive: p.alive, rank: p.rank,
    })),
  };
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────
function startCountdown(io, room) {
  room.phase     = 'countdown';
  room.countdown = COUNTDOWN_SECS;
  io.to(room.roomId).emit('lgs_countdown', { countdown: room.countdown });

  room.countdownInterval = setInterval(() => {
    room.countdown--;
    if (room.countdown > 0) {
      io.to(room.roomId).emit('lgs_countdown', { countdown: room.countdown });
    } else {
      clearInterval(room.countdownInterval);
      startGame(io, room);
    }
  }, 1000);
}

function startGame(io, room) {
  room.phase = 'playing'; room.scrollOffset = 0;
  room.elapsedSecs = 0; room.speedMultiplier = 1; room.finishCount = 0;

  room.players.forEach(p => {
    p.lane = 1; p.colOffset = 0; p.alive = true;
    p.eliminated = false; p.finishTime = null; p.rank = null;
  });

  room.totalAliveAtStart = room.players.size;
  room.laserPattern = randomLaserPattern(500, room.players.size);
  io.to(room.roomId).emit('lgs_start', buildGameState(room));

  let tickCount = 0;
  room.tickInterval = setInterval(() => {
    if (room.phase !== 'playing') { clearInterval(room.tickInterval); return; }

    tickCount++;
    if (tickCount % Math.round(1000 / TICK_MS) === 0) {
      room.elapsedSecs++;
      if (room.elapsedSecs % SPEED_BOOST_SECS === 0) {
        room.speedMultiplier = Math.min(room.speedMultiplier + 1, MAX_SPEED);
        io.to(room.roomId).emit('lgs_speedup', { speed: room.speedMultiplier });
      }
    }

    room.scrollOffset += room.speedMultiplier;

    room.players.forEach(p => {
      if (!p.alive) return;
      p.colOffset += room.speedMultiplier;
      const maxCol = room.laserPattern.length - 1;

      if (p.colOffset >= maxCol) {
        p.alive = false; room.finishCount++;
        p.rank = room.finishCount; p.finishTime = room.elapsedSecs;
        io.to(room.roomId).emit('lgs_finish', { playerId: p.id, name: p.name, rank: p.rank, time: p.finishTime });
        io.to(p.socketId).emit('lgs_you_finished', { rank: p.rank });
        return;
      }

      const col = room.laserPattern[Math.floor(p.colOffset)];
      if (col && col[p.lane]) {
        p.alive = false; p.eliminated = true;
        io.to(room.roomId).emit('lgs_eliminated', { playerId: p.id, name: p.name });
        io.to(p.socketId).emit('lgs_you_eliminated', {});
      }
    });

    const anyAlive = [...room.players.values()].some(p => p.alive);
    if (!anyAlive) { endGame(io, room); return; }
    io.to(room.roomId).emit('lgs_tick', buildGameState(room));
  }, TICK_MS);
}

function endGame(io, room) {
  clearInterval(room.tickInterval);
  room.phase = 'finished';
  const results = [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, rank: p.rank || 999, eliminated: p.eliminated, time: p.finishTime }))
    .sort((a, b) => a.rank - b.rank);
  io.to(room.roomId).emit('lgs_finished', { phase: 'finished', roomId: room.roomId, results });
}

function handleLeave(io, socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const player = room.players.get(socket.id);
  if (!player) return;

  room.players.delete(socket.id);
  socket.leave(roomId);

  if (room.players.size === 0) { destroyRoom(roomId); console.log(`🗑️  LGS room ${roomId} destroyed`); return; }

  if (player.isHost) {
    const next = room.players.values().next().value;
    if (next) { next.isHost = true; io.to(next.socketId).emit('lgs_you_are_host', {}); }
  }

  io.to(roomId).emit('lgs_player_left', { playerId: socket.id, name: player.name });
  io.to(roomId).emit('lgs_lobby', buildLobbyState(room));

  if (room.phase === 'playing') {
    const alive = [...room.players.values()].filter(p => p.alive);
    if (alive.length <= 1) endGame(io, room);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ✅ KEY FIX: This function takes (io, socket) — NOT io.on('connection') again
// Call this inside the existing io.on('connection') block in config/db.js
// ─────────────────────────────────────────────────────────────────────────────
function initializeLaserGridSprint(io, socket) {

  // ── CREATE ROOM ────────────────────────────────────────────────────────────
  socket.on('lgs_create_room', ({ name }) => {
    if (!name || typeof name !== 'string') return;
    const playerName = name.trim().slice(0, 20);
    const { roomId, room } = createRoom(playerName, socket.id);
    socket.join(roomId);
    socket.emit('lgs_room_created', { roomId, playerId: socket.id, isHost: true });
    io.to(roomId).emit('lgs_lobby', buildLobbyState(room));
    console.log(`🎮 LGS room created: ${roomId} by ${playerName}`);
  });

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
  socket.on('lgs_join_room', ({ name, roomId }) => {
    if (!name || !roomId) return;

    const isSpectator = typeof name === 'string' && name.startsWith('_DASH_');
    const cleanId = roomId.toUpperCase().trim();
    const room = rooms.get(cleanId);

    if (!room) { socket.emit('lgs_error', { message: 'Room not found. Check the Room ID.' }); return; }

    if (!isSpectator) {
      if (room.phase !== 'lobby') { socket.emit('lgs_error', { message: 'Game already started!' }); return; }
      if (room.players.size >= MAX_PLAYERS) { socket.emit('lgs_error', { message: 'Room is full (max 8 players).' }); return; }
      const player = createPlayer(name.trim().slice(0, 20), socket.id, false);
      room.players.set(socket.id, player);
      console.log(`👤 LGS ${name.trim()} joined room ${room.roomId}`);
    } else {
      console.log(`👁️  LGS Dashboard spectator joined room ${room.roomId}`);
    }

    socket.join(room.roomId);
    socket.emit('lgs_joined', { roomId: room.roomId, playerId: socket.id, isHost: false });

    if (!isSpectator) {
      io.to(room.roomId).emit('lgs_lobby', buildLobbyState(room));
    } else {
      // Send current state immediately to dashboard
      if (room.phase === 'lobby')    socket.emit('lgs_lobby', buildLobbyState(room));
      if (room.phase === 'playing')  socket.emit('lgs_start', buildGameState(room));
      if (room.phase === 'finished') socket.emit('lgs_lobby', buildLobbyState(room));
    }
  });

  // ── START GAME (host only) ─────────────────────────────────────────────────
  socket.on('lgs_start_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !player.isHost) { socket.emit('lgs_error', { message: 'Only the host can start.' }); return; }
    if (room.phase !== 'lobby') return;
    startCountdown(io, room);
  });

  // ── PLAYER SWIPE ───────────────────────────────────────────────────────────
  socket.on('lgs_swipe', ({ roomId, direction }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    if (direction === 'up')         player.lane = Math.max(0, player.lane - 1);
    else if (direction === 'down')  player.lane = Math.min(LANE_COUNT - 1, player.lane + 1);
    else if (direction === 'slide') player.colOffset = Math.min(player.colOffset + 3, room.laserPattern.length - 1);

    io.to(room.roomId).emit('lgs_player_moved', { playerId: player.id, lane: player.lane, colOffset: player.colOffset });
  });

  // ── RESET (host only) ──────────────────────────────────────────────────────
  socket.on('lgs_reset', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !player.isHost) return;
    clearInterval(room.tickInterval);
    clearInterval(room.countdownInterval);
    room.phase = 'lobby'; room.scrollOffset = 0;
    room.elapsedSecs = 0; room.speedMultiplier = 1; room.countdown = COUNTDOWN_SECS;
    room.players.forEach(p => { p.alive = true; p.eliminated = false; p.lane = 1; p.rank = null; });
    io.to(room.roomId).emit('lgs_lobby', buildLobbyState(room));
  });

  // ── LEAVE ROOM ─────────────────────────────────────────────────────────────
  socket.on('lgs_leave', ({ roomId }) => {
    handleLeave(io, socket, roomId);
  });

  // ── DISCONNECT — LGS cleanup only (db.js handles device cleanup) ───────────
  socket.on('disconnect', () => {
    const found = getRoomOfSocket(socket.id);
    if (found) handleLeave(io, socket, found.roomId);
  });
}

module.exports = { initializeLaserGridSprint };