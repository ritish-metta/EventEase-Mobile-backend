// ─────────────────────────────────────────────────────────────────────────────
// ruthless_battle.js  v2  —  RUTHLESS BATTLE ROYALE
// Room-based: create with code, join by code — like phone_football.js
// Dashboard: join room as _DASH_ spectator
// ─────────────────────────────────────────────────────────────────────────────

// ── ROOM ID GENERATOR ─────────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const RB_MAX_SOLDIERS        = 8;
const RB_BASE_HP             = 100;
const RB_BASE_ENERGY         = 100;
const RB_ENERGY_REGEN_TICK   = 500;
const RB_ENERGY_REGEN_AMT    = 2;
const RB_KILL_ENERGY_STEAL   = 0.4;
const RB_LAST_MAN_BONUS      = 15;
const RB_GROUND_WEAPON_INTERVAL = 25000;
const RB_GROUND_WEAPON_MAX   = 3;
const RB_DODGE_COOLDOWN      = 4000;
const RB_STUN_DURATION       = 2000;
const RB_POISON_TICK_DMG     = 3;
const RB_POISON_DURATION     = 8000;
const RB_FIRE_DMG_BONUS      = 0.5;
const RB_THUNDER_STUN_CHANCE = 0.35;
const RB_COUNTDOWN_SECS      = 5;
const RB_AUTO_START_DELAY    = 3000; // ms after 2+ players to suggest start

// ── WEAPONS ───────────────────────────────────────────────────────────────────
const RB_WEAPONS = {
  sword:        { name: 'Sword',         emoji: '⚔️',  dmg: 18, energyCost: 12, speed: 'medium', special: null         },
  spear:        { name: 'Spear',         emoji: '🏹',  dmg: 22, energyCost: 16, speed: 'medium', special: null         },
  axe:          { name: 'Axe',           emoji: '🪓',  dmg: 28, energyCost: 22, speed: 'slow',   special: null         },
  bow:          { name: 'Bow',           emoji: '🎯',  dmg: 15, energyCost: 10, speed: 'fast',   special: null         },
  hammer:       { name: 'Hammer',        emoji: '🔨',  dmg: 32, energyCost: 28, speed: 'slow',   special: 'stun'       },
  fists:        { name: 'Bare Fists',    emoji: '👊',  dmg: 10, energyCost:  6, speed: 'fast',   special: null         },
  thunderAxe:   { name: 'Thunder Axe',   emoji: '⚡',  dmg: 35, energyCost: 25, speed: 'medium', special: 'thunder'    },
  poisonBlade:  { name: 'Poison Blade',  emoji: '☠️',  dmg: 14, energyCost: 10, speed: 'fast',   special: 'poison'     },
  fireSword:    { name: 'Fire Sword',    emoji: '🔥',  dmg: 24, energyCost: 14, speed: 'medium', special: 'fire'       },
  iceStaff:     { name: 'Ice Staff',     emoji: '❄️',  dmg: 12, energyCost: 12, speed: 'fast',   special: 'freeze'     },
  shadowDagger: { name: 'Shadow Dagger', emoji: '🌑',  dmg: 20, energyCost:  8, speed: 'fast',   special: 'shadowstep' },
};
const RB_STARTER_WEAPONS = ['sword','spear','axe','bow','hammer','fists'];
const RB_RARE_WEAPONS    = ['thunderAxe','poisonBlade','fireSword','iceStaff','shadowDagger'];

// ── FIGHTING STYLES ───────────────────────────────────────────────────────────
const RB_STYLES = {
  kungfu:    { name: 'Kung Fu',   emoji: '🥋', dmgMult: 1.0, speedMult: 1.4, dodgeBonus: 0.30 },
  berserker: { name: 'Berserker',emoji: '😡', dmgMult: 1.6, speedMult: 0.7, dodgeBonus: 0.00 },
  archer:    { name: 'Archer',   emoji: '🏹', dmgMult: 1.1, speedMult: 1.2, dodgeBonus: 0.15 },
  shadow:    { name: 'Shadow',   emoji: '🌑', dmgMult: 1.3, speedMult: 1.1, dodgeBonus: 0.50 },
  monk:      { name: 'Monk',     emoji: '🧘', dmgMult: 1.1, speedMult: 1.0, dodgeBonus: 0.20 },
  titan:     { name: 'Titan',    emoji: '🗿', dmgMult: 1.2, speedMult: 0.8, dodgeBonus: 0.05 },
};
const RB_STYLE_KEYS = Object.keys(RB_STYLES);

// ── ROOMS MAP ─────────────────────────────────────────────────────────────────
const rbRooms = new Map(); // roomId → room

// ── SOLDIER FACTORY ───────────────────────────────────────────────────────────
function makeSoldier(socketId, name, isHost = false) {
  const styleKey  = RB_STYLE_KEYS[Math.floor(Math.random() * RB_STYLE_KEYS.length)];
  const style     = RB_STYLES[styleKey];
  const weaponKey = RB_STARTER_WEAPONS[Math.floor(Math.random() * RB_STARTER_WEAPONS.length)];
  const hpBonus   = styleKey === 'titan' ? 30 : 0;
  return {
    id: socketId, name: name.trim().slice(0, 20),
    socketId, styleKey, style,
    weaponKey, weapon: RB_WEAPONS[weaponKey],
    hp: RB_BASE_HP + hpBonus, maxHp: RB_BASE_HP + hpBonus,
    energy: RB_BASE_ENERGY, maxEnergy: RB_BASE_ENERGY,
    kills: 0, alive: true,
    stunned: false, frozen: false, poisoned: false,
    dodgeCooldown: 0, combo: 0, comboTimer: null,
    position: { x: 10 + Math.random()*80, y: 10 + Math.random()*80 },
    lastAttack: 0, isHost,
  };
}

// ── CREATE ROOM ───────────────────────────────────────────────────────────────
function createRoom(hostSocketId, hostName, soloMode = false) {

  const roomId = generateRoomId();
  const host   = makeSoldier(hostSocketId, hostName, true);
  const room = {
  roomId,
  soloMode,
  phase: 'lobby',

    
    // lobby|countdown|fighting|finished
    countdown: RB_COUNTDOWN_SECS,
    soldiers: new Map([[hostSocketId, host]]),
    groundWeapons: [],
    killFeed: [],
    round: 1,
    king: null, kingName: null,
    regenTimer: null, groundTimer: null, countdownTimer: null,
    poisonTimers: {}, stunTimers: {}, freezeTimers: {},
    lastGoalTime: 0,
  };
  rbRooms.set(roomId, room);
  return room;
}

// ── SNAPSHOT (for broadcasting) ───────────────────────────────────────────────
function roomSnap(room) {
  return {
    roomId:       room.roomId,
    phase:        room.phase,
    countdown:    room.countdown,
    round:        room.round,
    king:         room.king,
    kingName:     room.kingName,
    soldiers:     [...room.soldiers.values()].map(s => ({
      id: s.id, name: s.name,
      styleKey: s.styleKey, styleEmoji: s.style.emoji, styleName: s.style.name,
      weaponKey: s.weaponKey, weaponEmoji: s.weapon.emoji, weaponName: s.weapon.name,
      hp: Math.max(0, Math.round(s.hp)), maxHp: s.maxHp,
      energy: Math.round(s.energy), maxEnergy: s.maxEnergy,
      kills: s.kills, alive: s.alive,
      stunned: s.stunned, frozen: s.frozen, poisoned: s.poisoned,
      combo: s.combo, position: s.position, isHost: s.isHost,
    })),
    groundWeapons: room.groundWeapons,
    killFeed:      room.killFeed.slice(-10),
    aliveCnt:      [...room.soldiers.values()].filter(s=>s.alive).length,
  }; 
}  

function bcast(io, room, extra = {}) {
  io.to(room.roomId).emit('rb_state', { ...roomSnap(room), ...extra });
}

// ── LOBBY SNAPSHOT ────────────────────────────────────────────────────────────
function lobbySnap(room) {
  return {
    roomId:   room.roomId,
    phase:    room.phase,
    soldiers: [...room.soldiers.values()].map(s => ({
      id: s.id, name: s.name,
      styleKey: s.styleKey, styleEmoji: s.style.emoji, styleName: s.style.name,
      weaponKey: s.weaponKey, weaponEmoji: s.weapon.emoji, weaponName: s.weapon.name,
      hp: s.maxHp, maxHp: s.maxHp, isHost: s.isHost,
    })),
  };
}

// ── KILL FEED ─────────────────────────────────────────────────────────────────
function addKill(room, killerName, victimName, weaponEmoji) {
  room.killFeed.push({ t: Date.now(), killer: killerName, victim: victimName, weapon: weaponEmoji });
  if (room.killFeed.length > 20) room.killFeed.shift();
}

// ── GROUND WEAPONS ────────────────────────────────────────────────────────────
function spawnGroundWeapon(io, room) {
  if (room.groundWeapons.length >= RB_GROUND_WEAPON_MAX || room.phase !== 'fighting') return;
  const weaponKey = RB_RARE_WEAPONS[Math.floor(Math.random() * RB_RARE_WEAPONS.length)];
  const gw = {
    id: `gw_${Date.now()}`, weaponKey,
    weapon: RB_WEAPONS[weaponKey],
    x: 10 + Math.random() * 80, y: 10 + Math.random() * 80,
    spawnedAt: Date.now(),
  };
  room.groundWeapons.push(gw);
  bcast(io, room, { event: 'groundWeaponSpawned', groundWeapon: gw });
}

// ── APPLY DAMAGE ──────────────────────────────────────────────────────────────
function applyDamage(io, room, attacker, victim, dmg, weaponKey) {
  const weapon = RB_WEAPONS[weaponKey];
  let finalDmg = dmg * attacker.style.dmgMult;
  if (weaponKey === 'fireSword') finalDmg *= (1 + RB_FIRE_DMG_BONUS);

  // Dodge check
  if (Math.random() < victim.style.dodgeBonus && victim.dodgeCooldown <= Date.now()) {
    victim.dodgeCooldown = Date.now() + RB_DODGE_COOLDOWN;
    bcast(io, room, { event: 'dodge', who: victim.id });
    return false;
  }

  victim.hp = Math.max(0, victim.hp - finalDmg);

  // Stun
  if ((weapon.special === 'stun' || (weapon.special === 'thunder' && Math.random() < RB_THUNDER_STUN_CHANCE)) && !victim.stunned) {
    victim.stunned = true;
    if (room.stunTimers[victim.id]) clearTimeout(room.stunTimers[victim.id]);
    room.stunTimers[victim.id] = setTimeout(() => {
      if (room.soldiers.get(victim.id)) room.soldiers.get(victim.id).stunned = false;
    }, RB_STUN_DURATION);
  }

  // Poison
  if (weapon.special === 'poison' && !victim.poisoned) {
    victim.poisoned = true;
    if (room.poisonTimers[victim.id]) clearInterval(room.poisonTimers[victim.id]);
    let ticks = 0;
    room.poisonTimers[victim.id] = setInterval(() => {
      const v = room.soldiers.get(victim.id);
      if (!v || !v.alive) { clearInterval(room.poisonTimers[victim.id]); return; }
      v.hp = Math.max(0, v.hp - RB_POISON_TICK_DMG);
      ticks++;
      if (ticks >= RB_POISON_DURATION / 1000 || v.hp <= 0) {
        clearInterval(room.poisonTimers[victim.id]);
        if (v) v.poisoned = false;
        if (v && v.hp <= 0) handleDeath(io, room, v, attacker);
      }
    }, 1000);
  }

  // Freeze
  if (weapon.special === 'freeze' && !victim.frozen) {
    victim.frozen = true;
    if (room.freezeTimers[victim.id]) clearTimeout(room.freezeTimers[victim.id]);
    room.freezeTimers[victim.id] = setTimeout(() => {
      if (room.soldiers.get(victim.id)) room.soldiers.get(victim.id).frozen = false;
    }, 3000);
  }

  // Shadow step
  if (weapon.special === 'shadowstep') {
    attacker.position = { x: 10 + Math.random()*80, y: 10 + Math.random()*80 };
  }

  return true;
}

// ── HANDLE DEATH ──────────────────────────────────────────────────────────────
function handleDeath(io, room, victim, killer) {
  if (!victim.alive) return;
  victim.alive = false; victim.hp = 0;
  if (room.poisonTimers[victim.id])  { clearInterval(room.poisonTimers[victim.id]); victim.poisoned = false; }
  if (room.stunTimers[victim.id])    { clearTimeout(room.stunTimers[victim.id]);  victim.stunned = false; }
  if (room.freezeTimers[victim.id])  { clearTimeout(room.freezeTimers[victim.id]); victim.frozen  = false; }

  if (killer) {
    killer.kills++;
    const stolen = Math.floor(victim.maxEnergy * RB_KILL_ENERGY_STEAL);
    killer.maxEnergy = Math.min(200, killer.maxEnergy + stolen);
    killer.energy    = Math.min(killer.maxEnergy, killer.energy + stolen);
    killer.weaponKey = victim.weaponKey;
    killer.weapon    = victim.weapon;
    if (killer.comboTimer) clearTimeout(killer.comboTimer);
    killer.combo++;
    killer.comboTimer = setTimeout(() => { killer.combo = 0; }, 5000);
    const aliveCnt = [...room.soldiers.values()].filter(s=>s.alive).length;
    if (aliveCnt <= 3) killer.energy = Math.min(killer.maxEnergy, killer.energy + RB_LAST_MAN_BONUS);
    addKill(room, killer.name, victim.name, victim.weapon.emoji);
    const victimSocket = io.sockets.sockets.get(victim.id);
    if (victimSocket) victimSocket.emit('rb_you_died', { killedBy: killer.name, weapon: killer.weapon.emoji });
  }

  bcast(io, room, { event: 'soldierDied', who: victim.id, killedBy: killer?.id });

  const alive = [...room.soldiers.values()].filter(s=>s.alive);
  if (alive.length <= 1) setTimeout(() => endBattle(io, room, alive[0] || null), 800);
}

// ── END BATTLE ────────────────────────────────────────────────────────────────
function endBattle(io, room, winner) {
  clearInterval(room.regenTimer);
  clearInterval(room.groundTimer);
  room.phase   = 'finished';
  room.king    = winner?.id || null;
  room.kingName= winner?.name || null;
  if (winner) {
    const ws = io.sockets.sockets.get(winner.id);
    if (ws) ws.emit('rb_you_won', { kills: winner.kills });
  }
  bcast(io, room, { event: 'battleEnd', winner: winner?.id, winnerName: winner?.name });
  setTimeout(() => resetRoom(io, room), 15000);
}

// ── RESET ROOM ────────────────────────────────────────────────────────────────
function resetRoom(io, room) {
  clearInterval(room.regenTimer);
  clearInterval(room.groundTimer);
  clearTimeout(room.countdownTimer);
  Object.values(room.poisonTimers).forEach(clearInterval);
  Object.values(room.stunTimers).forEach(clearTimeout);
  Object.values(room.freezeTimers).forEach(clearTimeout);
  room.poisonTimers = {}; room.stunTimers = {}; room.freezeTimers = {};
  room.phase = 'lobby';
  room.countdown = RB_COUNTDOWN_SECS;
  room.groundWeapons = [];
  room.killFeed = [];
  room.round++;
  room.king = null; room.kingName = null;
  // Reset all soldiers
  room.soldiers.forEach(s => {
    const styleKey  = RB_STYLE_KEYS[Math.floor(Math.random() * RB_STYLE_KEYS.length)];
    const weaponKey = RB_STARTER_WEAPONS[Math.floor(Math.random() * RB_STARTER_WEAPONS.length)];
    const hpBonus   = styleKey === 'titan' ? 30 : 0;
    s.styleKey = styleKey; s.style = RB_STYLES[styleKey];
    s.weaponKey = weaponKey; s.weapon = RB_WEAPONS[weaponKey];
    s.hp = RB_BASE_HP + hpBonus; s.maxHp = RB_BASE_HP + hpBonus;
    s.energy = RB_BASE_ENERGY; s.maxEnergy = RB_BASE_ENERGY;
    s.kills = 0; s.alive = true;
    s.stunned = false; s.frozen = false; s.poisoned = false;
    s.combo = 0; s.dodgeCooldown = 0;
    s.position = { x: 10 + Math.random()*80, y: 10 + Math.random()*80 };
  });
  io.to(room.roomId).emit('rb_lobby', lobbySnap(room));
  bcast(io, room, { event: 'reset' });
}

// ── START COUNTDOWN ───────────────────────────────────────────────────────────
function startCountdown(io, room) {
  if (room.phase !== 'lobby') return;

  if (!room.soloMode && room.soldiers.size < 2) {
    io.to(room.roomId).emit('rb_error', { message: 'Need at least 2 soldiers!' });
    return;
  }

  room.phase = 'countdown';
  room.countdown = RB_COUNTDOWN_SECS;
  bcast(io, room, { event: 'countdownStart', soloMode: room.soloMode });

  room.countdownTimer = setInterval(() => {
    room.countdown--;
    bcast(io, room, { soloMode: room.soloMode });

    if (room.countdown <= 0) {
      clearInterval(room.countdownTimer);
      startFighting(io, room);
    }
  }, 1000);
}

function startFighting(io, room) {
  room.phase = 'fighting';
  room.soldiers.forEach(s => {
    s.position = { x: 5 + Math.random()*90, y: 5 + Math.random()*90 };
    s.alive = true; s.hp = s.maxHp;
  });
  bcast(io, room, { event: 'fightStart' });

  // Energy regen
  room.regenTimer = setInterval(() => {
    if (room.phase !== 'fighting') return;
    room.soldiers.forEach(s => {
      if (!s.alive || s.stunned) return;
      const amt = s.styleKey === 'monk' ? RB_ENERGY_REGEN_AMT * 2 : RB_ENERGY_REGEN_AMT;
      s.energy = Math.min(s.maxEnergy, s.energy + amt);
    });
    bcast(io, room);
  }, RB_ENERGY_REGEN_TICK);

  // Ground weapons
  room.groundTimer = setInterval(() => spawnGroundWeapon(io, room), RB_GROUND_WEAPON_INTERVAL);
  setTimeout(() => spawnGroundWeapon(io, room), 10000);
}

// ── DESTROY ROOM ──────────────────────────────────────────────────────────────
function destroyRoom(room) {
  clearInterval(room.regenTimer);
  clearInterval(room.groundTimer);
  clearTimeout(room.countdownTimer);
  Object.values(room.poisonTimers).forEach(clearInterval);
  Object.values(room.stunTimers).forEach(clearTimeout);
  Object.values(room.freezeTimers).forEach(clearTimeout);
  rbRooms.delete(room.roomId);
}

// ── HANDLE LEAVE ──────────────────────────────────────────────────────────────
function handleLeave(io, socket, roomId) {
  const room = rbRooms.get(roomId);
  if (!room) return;
  const s = room.soldiers.get(socket.id);
  if (!s) return;
  room.soldiers.delete(socket.id);
  socket.leave(roomId);

  const remaining = [...room.soldiers.values()];
  if (remaining.length === 0) { destroyRoom(room); return; }

  // Reassign host if needed
  if (s.isHost) {
    remaining[0].isHost = true;
    io.to(remaining[0].id).emit('rb_you_are_host', {});
  }

  if (room.phase === 'lobby') {
    io.to(roomId).emit('rb_lobby', lobbySnap(room));
  } else if (room.phase === 'fighting' && s.alive) {
    handleDeath(io, room, s, null);
    addKill(room, '???', s.name, '🏃');
  }
  bcast(io, room, { event: 'soldierLeft', name: s.name });
}

function findRoomOf(socketId) {
  for (const [, room] of rbRooms) {
    if (room.soldiers.has(socketId)) return room;
  }
  return null;
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
function initializeRuthlessBattle(io, socket) {

  // ── CREATE ROOM ─────────────────────────────────────────────────────────────
 socket.on('rb_create_room', ({ name, soloMode }) => {

    if (!name || typeof name !== 'string') return;
    const isSpectator = name.startsWith('_DASH_');
    if (isSpectator) { socket.emit('rb_error', { message: 'Use rb_join_room to spectate' }); return; }
    const room = createRoom(socket.id, name, soloMode === true);

    socket.join(room.roomId);


    socket.emit('rb_room_created', {
  roomId: room.roomId,
  playerId: socket.id,
  isHost: true,
  soloMode: room.soloMode,
  soldier: roomSnap(room).soldiers[0],
});


    io.to(room.roomId).emit('rb_lobby', { ...lobbySnap(room), soloMode: room.soloMode });

    console.log(`⚔️  Room created: ${room.roomId} by ${name}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────────────────
  socket.on('rb_join_room', ({ name, roomId }) => {
    if (!name || !roomId) return;
    const isSpectator = name.startsWith('_DASH_');
    const cleanId = roomId.toUpperCase().trim();
    const room = rbRooms.get(cleanId);
    if (!room) { socket.emit('rb_error', { message: 'Room not found — check the code' }); return; }

    if (!isSpectator) {
      if (room.phase !== 'lobby') { socket.emit('rb_error', { message: 'Battle already started!' }); return; }
      if (room.soldiers.size >= RB_MAX_SOLDIERS) { socket.emit('rb_error', { message: 'Room full (max 8)' }); return; }
      const soldier = makeSoldier(socket.id, name);
      room.soldiers.set(socket.id, soldier);
      socket.join(room.roomId);
socket.emit('rb_joined', {
  roomId: room.roomId,
  playerId: socket.id,
  isHost: false,
  soloMode: room.soloMode,
  soldier: roomSnap(room).soldiers.find(s => s.id === socket.id),
});

      io.to(room.roomId).emit('rb_lobby', lobbySnap(room));
      console.log(`⚔️  ${name} joined room ${room.roomId}`);
    } else {
      // Dashboard spectator
      socket.join(room.roomId);
      socket.emit('rb_joined', { roomId: room.roomId, isSpectator: true });
      if (room.phase === 'lobby')    socket.emit('rb_lobby', lobbySnap(room));
      if (room.phase !== 'lobby')    socket.emit('rb_state', roomSnap(room));
      console.log(`👁  Dashboard spectating room ${cleanId}`);
    }
  });

  // ── START BATTLE (host only) ──────────────────────────────────────────────
  socket.on('rb_start_battle', ({ roomId }) => {
    const room = rbRooms.get(roomId);
    if (!room) return;
    const s = room.soldiers.get(socket.id);
    if (!s?.isHost) { socket.emit('rb_error', { message: 'Only host can start' }); return; }
    startCountdown(io, room);
  });

  // ── ATTACK ───────────────────────────────────────────────────────────────────
  socket.on('rb_attack', ({ roomId, targetId }) => {
    const room = rbRooms.get(roomId);
    if (!room || room.phase !== 'fighting') return;
    const attacker = room.soldiers.get(socket.id);
    const victim   = room.soldiers.get(targetId);
    if (!attacker || !victim || !attacker.alive || !victim.alive) return;
    if (attacker.stunned || attacker.frozen) return;
    const weapon = attacker.weapon;
    const now    = Date.now();
    const cooldowns = { fast: 400, medium: 700, slow: 1100 };
    const cd = cooldowns[weapon.speed] / attacker.style.speedMult;
    if (now - attacker.lastAttack < cd || attacker.energy < weapon.energyCost) return;
    attacker.energy -= weapon.energyCost;
    attacker.lastAttack = now;
    const hit = applyDamage(io, room, attacker, victim, weapon.dmg, attacker.weaponKey);
    if (hit) {
      const vs = io.sockets.sockets.get(targetId);
      if (vs) vs.emit('rb_got_hit', { by: attacker.name, weapon: weapon.emoji, damage: Math.round(weapon.dmg * attacker.style.dmgMult), special: weapon.special });
      if (victim.hp <= 0) { handleDeath(io, room, victim, attacker); return; }
    }
    bcast(io, room, { event: hit ? 'attacked' : 'attackDodged', attacker: socket.id, target: targetId, weapon: weapon.emoji, damage: hit ? Math.round(weapon.dmg * attacker.style.dmgMult) : 0 });
  });

  // ── HEAVY ATTACK ─────────────────────────────────────────────────────────────
  socket.on('rb_heavy_attack', ({ roomId, targetId }) => {
    const room = rbRooms.get(roomId);
    if (!room || room.phase !== 'fighting') return;
    const attacker = room.soldiers.get(socket.id);
    const victim   = room.soldiers.get(targetId);
    if (!attacker || !victim || !attacker.alive || !victim.alive) return;
    if (attacker.stunned || attacker.frozen) return;
    const heavyCost = attacker.weapon.energyCost * 2.2;
    if (attacker.energy < heavyCost) return;
    attacker.energy -= heavyCost;
    attacker.lastAttack = Date.now();
    const heavyDmg = attacker.weapon.dmg * 2.2 * attacker.style.dmgMult;
    victim.hp = Math.max(0, victim.hp - heavyDmg);
    const vs = io.sockets.sockets.get(targetId);
    if (vs) vs.emit('rb_got_hit', { by: attacker.name, weapon: attacker.weapon.emoji, damage: Math.round(heavyDmg), special: 'heavy', isHeavy: true });
    if (victim.hp <= 0) { handleDeath(io, room, victim, attacker); return; }
    bcast(io, room, { event: 'heavyAttack', attacker: socket.id, target: targetId, weapon: attacker.weapon.emoji, damage: Math.round(heavyDmg) });
  });

  // ── DODGE ────────────────────────────────────────────────────────────────────
  socket.on('rb_dodge', ({ roomId }) => {
    const room = rbRooms.get(roomId);
    if (!room || room.phase !== 'fighting') return;
    const s = room.soldiers.get(socket.id);
    if (!s || !s.alive || s.stunned || s.frozen) return;
    if (Date.now() < s.dodgeCooldown) return;
    s.dodgeCooldown = Date.now() + RB_DODGE_COOLDOWN;
    s.energy = Math.max(0, s.energy - 8);
    s.position = { x: 5 + Math.random()*90, y: 5 + Math.random()*90 };
    bcast(io, room, { event: 'dodgeRoll', who: socket.id });
  });

  // ── TAUNT ────────────────────────────────────────────────────────────────────
  socket.on('rb_taunt', ({ roomId, targetId }) => {
    const room = rbRooms.get(roomId);
    if (!room || room.phase !== 'fighting') return;
    const s = room.soldiers.get(socket.id);
    if (!s || !s.alive || s.energy < 15) return;
    s.energy -= 15;
    const target = room.soldiers.get(targetId);
    if (target) target.energy = Math.max(0, target.energy - 10);
    bcast(io, room, { event: 'taunt', who: socket.id, target: targetId });
  });

  // ── PICKUP WEAPON ─────────────────────────────────────────────────────────────
  socket.on('rb_pickup', ({ roomId, weaponId }) => {
    const room = rbRooms.get(roomId);
    if (!room || room.phase !== 'fighting') return;
    const s = room.soldiers.get(socket.id);
    if (!s || !s.alive) return;
    const idx = room.groundWeapons.findIndex(gw => gw.id === weaponId);
    if (idx === -1) return;
    const gw = room.groundWeapons.splice(idx, 1)[0];
    s.weaponKey = gw.weaponKey; s.weapon = gw.weapon;
    socket.emit('rb_weapon_picked', { weapon: gw.weapon });
    bcast(io, room, { event: 'weaponPickedUp', who: socket.id, weapon: gw.weapon.emoji, weaponId });
  });

  // ── RESET ─────────────────────────────────────────────────────────────────────
  socket.on('rb_reset', ({ roomId }) => {
    const room = rbRooms.get(roomId);
    if (!room) return;
    const s = room.soldiers.get(socket.id);
    if (!s?.isHost) return;
    resetRoom(io, room);
  });

  // ── GET STATE ─────────────────────────────────────────────────────────────────
  socket.on('rb_get_state', ({ roomId }) => {
    const room = rbRooms.get(roomId);
    if (!room) return;
    if (room.phase === 'lobby') socket.emit('rb_lobby', lobbySnap(room));
    else socket.emit('rb_state', roomSnap(room));
  });

  // ── LEAVE ─────────────────────────────────────────────────────────────────────
  socket.on('rb_leave', ({ roomId }) => handleLeave(io, socket, roomId));

  socket.on('disconnect', () => {
    const room = findRoomOf(socket.id);
    if (room) handleLeave(io, socket, room.roomId);
  });
}

module.exports = { initializeRuthlessBattle }; 