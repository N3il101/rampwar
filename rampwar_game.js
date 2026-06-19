// ═══════════════════════════════════════════════
//  RAMP WAR — game.js
//  Three.js 3D · PeerJS P2P Multiplayer
// ═══════════════════════════════════════════════

'use strict';

// ── CONSTANTS ──────────────────────────────────
const PLATFORM_W = 18, PLATFORM_D = 18, PLATFORM_H = 0.5;
const PLATFORM_Y = 7;
const RAMP_LENGTH = 28, RAMP_RISE = PLATFORM_Y + PLATFORM_H;
const GRAVITY = -22;
const CAR_SPEED = 18;
const CAR_TURN = 2.2;
const ROCKET_SPEED = 45;
const ROCKET_AMMO_MAX = 6;
const ROCKET_RELOAD_MS = 4000;
const ROUND_SECONDS = 120;
const FALL_DEATH_Y = -5;
const EXPLOSION_RADIUS = 6;
const EXPLOSION_FORCE = 18;
const SYNC_RATE = 50;

// ── STATE ──────────────────────────────────────
const State = {
  scene: null, camera: null, renderer: null, clock: null,
  localId: null, localName: '', localTeam: '',
  isHost: false, peer: null, connections: {},
  players: {}, rockets: [], explosions: [],
  keys: {},
  isDead: false, isSpectating: false,
  roundTimer: ROUND_SECONDS, gameRunning: false,
  lastSync: 0,
  ammo: ROCKET_AMMO_MAX, reloading: false,
  objects: {}, groundObjects: [],
};

let yaw = 0, pitch = 0;

// ── UTILS ─────────────────────────────────────
function randId(n = 6) { return Math.random().toString(36).slice(2, 2 + n).toUpperCase(); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function setStatus(msg, cls = '') { const el = document.getElementById('status-msg'); el.textContent = msg; el.className = cls; }
function showEl(id, flex = false) { document.getElementById(id).style.display = flex ? 'flex' : 'block'; }
function hideEl(id) { document.getElementById(id).style.display = 'none'; }

// ── PLAYER DATA ───────────────────────────────
function makePlayer(id, name, team) {
  return { id, name, team, alive: true,
    pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    speed: 0, mesh: null, onGround: false };
}

// ── LOBBY ─────────────────────────────────────
document.getElementById('host-btn').addEventListener('click', hostGame);
document.getElementById('join-btn').addEventListener('click', joinGame);
document.getElementById('start-game-btn').addEventListener('click', startGame);
document.getElementById('play-again-btn').addEventListener('click', () => location.reload());
document.getElementById('join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function getPlayerName() { return document.getElementById('player-name').value.trim() || 'Player' + Math.floor(Math.random() * 999); }
function getTeamPref() { return document.getElementById('team-select').value; }

function hostGame() {
  State.localName = getPlayerName();
  const tp = getTeamPref();
  State.localTeam = tp === 'auto' ? 'defenders' : tp;
  State.isHost = true;
  State.localId = randId(6);
  setStatus('Opening room…');
  State.peer = new Peer(State.localId, { debug: 1 });
  State.peer.on('open', id => {
    document.getElementById('room-code-text').textContent = id;
    showEl('room-code-display');
    setStatus('Room open — share the code!', 'ok');
    State.players[id] = makePlayer(id, State.localName, State.localTeam);
    showWaitingRoom();
    updateWaitingRoom();
  });
  State.peer.on('connection', conn => {
    conn.on('open', () => {
      conn.send({ type: 'welcome', players: State.players, hostId: State.localId });
      setupConn(conn);
    });
  });
  State.peer.on('error', e => setStatus('Error: ' + e.type, 'error'));
}

function joinGame() {
  State.localName = getPlayerName();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code || code.length !== 6) { setStatus('Enter a valid 6-letter code', 'error'); return; }
  State.localId = randId(6);
  State.isHost = false;
  setStatus('Connecting…');
  State.peer = new Peer(State.localId, { debug: 1 });
  State.peer.on('open', id => {
    State.localId = id;
    const conn = State.peer.connect(code, { reliable: true });
    State.connections[code] = conn;
    conn.on('open', () => {
      setStatus('Connected!', 'ok');
      conn.send({ type: 'join', id, name: State.localName, teamPref: getTeamPref() });
      setupConn(conn);
    });
    conn.on('error', e => setStatus('Connection failed', 'error'));
  });
  State.peer.on('error', e => setStatus('Could not connect: ' + e.type, 'error'));
}

function setupConn(conn) {
  conn.on('data', data => handleNet(conn, data));
  conn.on('close', () => {
    const p = State.players[conn.peer];
    if (p) { p.alive = false; if (p.mesh) p.mesh.visible = false; }
    if (State.gameRunning && State.isHost) checkWinCondition();
    updateHUD();
  });
}

function handleNet(conn, msg) {
  switch (msg.type) {

    case 'join': {
      const defC = Object.values(State.players).filter(p => p.team === 'defenders').length;
      const atkC = Object.values(State.players).filter(p => p.team === 'attackers').length;
      let team = (msg.teamPref && msg.teamPref !== 'auto') ? msg.teamPref : (defC <= atkC ? 'defenders' : 'attackers');
      const player = makePlayer(msg.id, msg.name, team);
      State.players[msg.id] = player;
      State.connections[msg.id] = conn;
      broadcast({ type: 'player_joined', player });
      conn.send({ type: 'welcome', players: State.players, hostId: State.localId });
      updateWaitingRoom();
      break;
    }

    case 'welcome': {
      State.players = {};
      Object.values(msg.players).forEach(p => { State.players[p.id] = makePlayer(p.id, p.name, p.team); });
      if (!State.players[State.localId]) {
        const defC = Object.values(State.players).filter(p => p.team === 'defenders').length;
        const atkC = Object.values(State.players).filter(p => p.team === 'attackers').length;
        const tp = getTeamPref();
        State.localTeam = tp !== 'auto' ? tp : (defC <= atkC ? 'defenders' : 'attackers');
        State.players[State.localId] = makePlayer(State.localId, State.localName, State.localTeam);
      } else {
        State.localTeam = State.players[State.localId].team;
      }
      showWaitingRoom();
      updateWaitingRoom();
      break;
    }

    case 'player_joined': {
      if (!State.players[msg.player.id]) State.players[msg.player.id] = makePlayer(msg.player.id, msg.player.name, msg.player.team);
      updateWaitingRoom();
      break;
    }

    case 'start': {
      Object.assign(State.players, msg.players);
      Object.values(State.players).forEach(p => { if (!p.vel) p.vel = { x:0,y:0,z:0 }; });
      State.localTeam = State.players[State.localId]?.team || 'defenders';
      hideEl('waiting-room');
      beginGame();
      break;
    }

    case 'sync': {
      const p = State.players[msg.id];
      if (p && msg.id !== State.localId) {
        Object.assign(p.pos, msg.pos);
        Object.assign(p.rot, msg.rot);
        if (msg.vel) Object.assign(p.vel, msg.vel);
        p.speed = msg.speed || 0;
        p.alive = msg.alive;
        if (p.mesh) { p.mesh.position.set(p.pos.x, p.pos.y, p.pos.z); p.mesh.rotation.y = p.rot.y; }
      }
      if (State.isHost && msg.id !== State.localId) broadcast(msg); // relay
      break;
    }

    case 'rocket_fired': {
      if (msg.ownerId !== State.localId) spawnRocket(msg);
      if (State.isHost) broadcast(msg);
      break;
    }

    case 'explosion': {
      createExplosion(new THREE.Vector3(msg.x, msg.y, msg.z), false);
      if (State.isHost) broadcast(msg);
      break;
    }

    case 'player_died': {
      const p2 = State.players[msg.id];
      if (p2) { p2.alive = false; if (p2.mesh) p2.mesh.visible = false; }
      updateHUD();
      if (State.isHost) { broadcast(msg); checkWinCondition(); }
      break;
    }

    case 'push': {
      if (msg.targetId === State.localId) {
        const lp = State.players[State.localId];
        if (lp) { lp.vel.x += msg.force.x; lp.vel.y += msg.force.y; lp.vel.z += msg.force.z; }
      }
      if (State.isHost) broadcast(msg);
      break;
    }

    case 'game_over': {
      endGame(msg.winTeam);
      break;
    }

    case 'timer': {
      if (!State.isHost) {
        State.roundTimer = msg.t;
        updateTimerDisplay(msg.t);
      }
      break;
    }
  }
}

function broadcast(msg) {
  Object.values(State.connections).forEach(c => { try { c.send(msg); } catch(e){} });
}

function sendToHost(msg) {
  const c = Object.values(State.connections)[0];
  if (c) try { c.send(msg); } catch(e) {}
}

function relay(msg) {
  if (State.isHost) broadcast(msg);
  else sendToHost(msg);
}

// ── WAITING ROOM ──────────────────────────────
function showWaitingRoom() {
  hideEl('lobby');
  showEl('waiting-room', true);
  if (State.isHost) showEl('start-game-btn');
}

function updateWaitingRoom() {
  const c = document.getElementById('waiting-players');
  c.innerHTML = '';
  Object.values(State.players).forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'waiting-player-chip';
    chip.innerHTML = `<div class="wdot"></div>${p.team === 'defenders' ? '🔴' : '🔵'} ${p.name}`;
    c.appendChild(chip);
  });
  const n = Object.values(State.players).length;
  document.getElementById('peer-status').textContent = `${n} player${n !== 1 ? 's' : ''} in lobby`;
}

function startGame() {
  if (!State.isHost) return;
  assignSpawns();
  broadcast({ type: 'start', players: State.players });
  hideEl('waiting-room');
  beginGame();
}

function assignSpawns() {
  const defs = Object.values(State.players).filter(p => p.team === 'defenders');
  const atks = Object.values(State.players).filter(p => p.team === 'attackers');
  defs.forEach((p, i) => {
    const s = (i - (defs.length - 1) / 2) * 4;
    p.pos = { x: s, y: PLATFORM_Y + 1.5, z: 2 };
    p.rot = { x: 0, y: 0, z: 0 }; p.vel = { x: 0, y: 0, z: 0 };
  });
  atks.forEach((p, i) => {
    const s = (i - (atks.length - 1) / 2) * 5;
    p.pos = { x: s, y: 1, z: -24 };
    p.rot = { x: 0, y: 0, z: 0 }; p.vel = { x: 0, y: 0, z: 0 };
  });
}

// ── SCENE ─────────────────────────────────────
function beginGame() {
  State.gameRunning = true;
  State.roundTimer = ROUND_SECONDS;

  const canvas = document.getElementById('game-canvas');
  State.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  State.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  State.renderer.setSize(window.innerWidth, window.innerHeight);
  State.renderer.shadowMap.enabled = true;
  State.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  State.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  State.renderer.toneMappingExposure = 1.1;

  State.scene = new THREE.Scene();
  State.scene.background = new THREE.Color(0x08080f);
  State.scene.fog = new THREE.Fog(0x08080f, 60, 130);

  State.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
  State.clock = new THREE.Clock();

  buildLights();
  buildWorld();
  Object.values(State.players).forEach(p => spawnMesh(p));

  const lp = State.players[State.localId];
  if (lp && lp.mesh) lp.mesh.position.set(lp.pos.x, lp.pos.y, lp.pos.z);

  setupInput();
  showEl('canvas-container');
  showEl('hud');
  showEl('controls-hint');
  updateHUD();
  updateRoleBanner();
  updateAmmoBar();

  State.renderer.setAnimationLoop(gameLoop);
  window.addEventListener('resize', () => {
    State.camera.aspect = window.innerWidth / window.innerHeight;
    State.camera.updateProjectionMatrix();
    State.renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function buildLights() {
  State.scene.add(new THREE.AmbientLight(0x1a1a2e, 2.5));
  const sun = new THREE.DirectionalLight(0xffa060, 3.5);
  sun.position.set(20, 40, 20);
  sun.castShadow = true;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 150;
  sun.shadow.camera.left = -50; sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50; sun.shadow.camera.bottom = -50;
  sun.shadow.mapSize.setScalar(2048); sun.shadow.bias = -0.001;
  State.scene.add(sun);
  const fill = new THREE.PointLight(0x00d4ff, 4, 30);
  fill.position.set(0, PLATFORM_Y - 3, 0);
  State.scene.add(fill);
  const rg = new THREE.PointLight(0xff4d00, 3, 25);
  rg.position.set(0, 2, -14);
  State.scene.add(rg);
}

function buildWorld() {
  // Ground plane
  const gm = new THREE.MeshStandardMaterial({ color: 0x0d0d1a, roughness: 0.95 });
  const gg = new THREE.PlaneGeometry(300, 300);
  const gnd = new THREE.Mesh(gg, gm);
  gnd.rotation.x = -Math.PI / 2; gnd.position.y = -0.5; gnd.receiveShadow = true;
  State.scene.add(gnd);

  buildPlatform();
  buildRamp();
  buildWalls();
  buildGrid();
  buildStars();

  // Register collision: flat ground
  State.groundObjects.push({ type: 'box', minX: -100, maxX: 100, y: 0, minZ: -200, maxZ: 60 });
}

function buildPlatform() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.6, metalness: 0.4 });
  const geo = new THREE.BoxGeometry(PLATFORM_W, PLATFORM_H, PLATFORM_D);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, PLATFORM_Y, 0); mesh.receiveShadow = true; mesh.castShadow = true;
  State.scene.add(mesh);
  State.objects.platform = mesh;

  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x00d4ff, emissive: 0x00d4ff, emissiveIntensity: 0.6, roughness: 0.3 });
  [
    { pos: [0, PLATFORM_Y + PLATFORM_H/2+0.06, PLATFORM_D/2], size: [PLATFORM_W, 0.07, 0.14] },
    { pos: [0, PLATFORM_Y + PLATFORM_H/2+0.06, -PLATFORM_D/2], size: [PLATFORM_W, 0.07, 0.14] },
    { pos: [PLATFORM_W/2, PLATFORM_Y + PLATFORM_H/2+0.06, 0], size: [0.14, 0.07, PLATFORM_D] },
    { pos: [-PLATFORM_W/2, PLATFORM_Y + PLATFORM_H/2+0.06, 0], size: [0.14, 0.07, PLATFORM_D] },
  ].forEach(e => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...e.size), edgeMat);
    m.position.set(...e.pos); State.scene.add(m);
  });

  const pm = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.8 });
  [[-6,6],[6,6],[-6,-6],[6,-6]].forEach(([x,z]) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.5,PLATFORM_Y,8), pm);
    p.position.set(x, PLATFORM_Y/2, z); p.castShadow = true; State.scene.add(p);
  });

  State.groundObjects.push({
    type: 'box', minX: -PLATFORM_W/2, maxX: PLATFORM_W/2,
    y: PLATFORM_Y + PLATFORM_H/2, minZ: -PLATFORM_D/2, maxZ: PLATFORM_D/2
  });
}

function buildRamp() {
  const rampAngle = Math.atan2(RAMP_RISE, RAMP_LENGTH);
  const rampLen = Math.sqrt(RAMP_LENGTH*RAMP_LENGTH + RAMP_RISE*RAMP_RISE);
  const rampW = 10;
  const mat = new THREE.MeshStandardMaterial({ color: 0x1e1a10, roughness: 0.7, metalness: 0.3 });
  const geo = new THREE.BoxGeometry(rampW, 0.4, rampLen);
  const ramp = new THREE.Mesh(geo, mat);
  ramp.position.set(0, RAMP_RISE/2, -RAMP_LENGTH/2);
  ramp.rotation.x = rampAngle;
  ramp.castShadow = true; ramp.receiveShadow = true;
  State.scene.add(ramp);

  const sm = new THREE.MeshStandardMaterial({ color: 0xff4d00, emissive: 0xff4d00, emissiveIntensity: 0.5 });
  [-rampW/2, rampW/2].forEach(x => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, rampLen), sm);
    s.position.set(x, RAMP_RISE/2+0.22, -RAMP_LENGTH/2);
    s.rotation.x = rampAngle; State.scene.add(s);
  });

  State.groundObjects.push({
    type: 'ramp', minX: -rampW/2, maxX: rampW/2,
    minZ: -RAMP_LENGTH, maxZ: 0,
    startY: 0, endY: RAMP_RISE, rampLength: RAMP_LENGTH,
  });
}

function buildWalls() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x111133, roughness: 0.8, metalness: 0.3, transparent: true, opacity: 0.55 });
  const wallH = 0.9, wallT = 0.3, py = PLATFORM_Y + PLATFORM_H/2 + wallH/2;
  const walls = [
    { g: [PLATFORM_W, wallH, wallT], p: [0, py, PLATFORM_D/2] },
    { g: [wallT, wallH, PLATFORM_D], p: [-PLATFORM_W/2, py, 0] },
    { g: [wallT, wallH, PLATFORM_D], p: [PLATFORM_W/2, py, 0] },
  ];
  walls.forEach(w => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...w.g), mat);
    m.position.set(...w.p); State.scene.add(m);
  });
}

function buildGrid() {
  const mat = new THREE.LineBasicMaterial({ color: 0x1a2040, transparent: true, opacity: 0.4 });
  const SIZE = 80, STEP = 8;
  for (let i = -SIZE; i <= SIZE; i += STEP) {
    const h = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-SIZE,-0.48,i), new THREE.Vector3(SIZE,-0.48,i)]);
    const v = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,-0.48,-SIZE), new THREE.Vector3(i,-0.48,SIZE)]);
    State.scene.add(new THREE.Line(h,mat)); State.scene.add(new THREE.Line(v,mat));
  }
}

function buildStars() {
  const count = 800, pos = new Float32Array(count*3);
  for (let i=0; i<count; i++) {
    pos[i*3]=(Math.random()-0.5)*300; pos[i*3+1]=Math.random()*80+20; pos[i*3+2]=(Math.random()-0.5)*300;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  State.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, sizeAttenuation: true })));
}

// ── MESHES ────────────────────────────────────
function spawnMesh(player) {
  const isLocal = player.id === State.localId;
  const isDef = player.team === 'defenders';
  const group = new THREE.Group();

  if (isDef) {
    const bm = new THREE.MeshStandardMaterial({ color: isLocal ? 0xff6030 : 0xcc3010, roughness: 0.5, metalness: 0.2, emissive: isLocal ? 0xff2000 : 0x880000, emissiveIntensity: 0.15 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1, 0.4), bm);
    body.position.y = 0.5; body.castShadow = true; group.add(body);
    const hm = new THREE.MeshStandardMaterial({ color: 0xf4c080, roughness: 0.7 });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.45), hm);
    head.position.y = 1.25; head.castShadow = true; group.add(head);
    const rm = new THREE.MeshStandardMaterial({ color: 0x404040, roughness: 0.4, metalness: 0.8 });
    const rpg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.2, 8), rm);
    rpg.rotation.z = -Math.PI/2; rpg.position.set(0.55, 0.7, 0); group.add(rpg);
  } else {
    const cm = new THREE.MeshStandardMaterial({ color: isLocal ? 0x00aaff : 0x0055cc, roughness: 0.3, metalness: 0.7, emissive: isLocal ? 0x0050ff : 0x002288, emissiveIntensity: 0.2 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.2), cm);
    body.position.y = 0.6; body.castShadow = true; group.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 1.6), cm);
    cab.position.set(0, 1.15, 0.2); cab.castShadow = true; group.add(cab);
    const lm = new THREE.MeshStandardMaterial({ color: 0xfff4aa, emissive: 0xfff4aa, emissiveIntensity: 1.5 });
    [-0.55,0.55].forEach(x => {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.15, 0.05), lm);
      hl.position.set(x, 0.65, -1.62); group.add(hl);
    });
    const wm = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const rim = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.3, metalness: 0.9 });
    [[-0.95,0.3,-1.0],[0.95,0.3,-1.0],[-0.95,0.3,1.0],[0.95,0.3,1.0]].forEach(([x,y,z]) => {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.3,0.25,12), wm);
      w.rotation.z = Math.PI/2; w.position.set(x,y,z); w.castShadow=true; group.add(w);
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.14,0.14,0.26,6), rim);
      r.rotation.z = Math.PI/2; r.position.set(x,y,z); group.add(r);
    });
  }

  // Name indicator dot
  const ind = new THREE.Mesh(new THREE.SphereGeometry(0.12,6,6), new THREE.MeshBasicMaterial({ color: isLocal ? 0xffffff : 0xffcc00 }));
  ind.position.y = isDef ? 2.1 : 2.2;
  group.add(ind);

  group.position.set(player.pos.x, player.pos.y, player.pos.z);
  group.rotation.y = player.rot.y;
  State.scene.add(group);
  player.mesh = group;
}

// ── INPUT ─────────────────────────────────────
function setupInput() {
  document.addEventListener('keydown', e => { State.keys[e.code] = true; e.preventDefault(); });
  document.addEventListener('keyup', e => { State.keys[e.code] = false; });
  const canvas = document.getElementById('game-canvas');
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
    else if (!State.isDead) handleAction();
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) document.addEventListener('mousemove', onMouseMove);
    else document.removeEventListener('mousemove', onMouseMove);
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}

function onMouseMove(e) {
  yaw -= e.movementX * 0.002;
  pitch = clamp(pitch - e.movementY * 0.002, -0.5, 0.6);
}

function handleAction() {
  const lp = State.players[State.localId];
  if (!lp || !lp.alive) return;
  if (lp.team === 'defenders') fireRocket();
}

// ── ROCKETS ───────────────────────────────────
function fireRocket() {
  if (State.ammo <= 0 || State.reloading) return;
  State.ammo--;
  updateAmmoBar();
  const lp = State.players[State.localId];
  if (!lp) return;
  const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  const origin = new THREE.Vector3(lp.pos.x, lp.pos.y + 0.9, lp.pos.z);
  const data = { id: randId(8), ownerId: State.localId, pos: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: dir.x, y: dir.y, z: dir.z } };
  spawnRocket(data);
  relay({ type: 'rocket_fired', ...data });
  if (State.ammo <= 0) {
    State.reloading = true;
    setTimeout(() => { State.ammo = ROCKET_AMMO_MAX; State.reloading = false; updateAmmoBar(); }, ROCKET_RELOAD_MS);
  }
}

function spawnRocket(data) {
  const geo = new THREE.CylinderGeometry(0.05, 0.12, 0.6, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff6600, emissive: 0xff2200, emissiveIntensity: 2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(data.pos.x, data.pos.y, data.pos.z);
  const tl = new THREE.PointLight(0xff4400, 3, 4);
  mesh.add(tl);
  State.scene.add(mesh);
  const dir = new THREE.Vector3(data.dir.x, data.dir.y, data.dir.z).normalize();
  State.rockets.push({ id: data.id, ownerId: data.ownerId, pos: mesh.position, dir, mesh, alive: true, age: 0 });
}

function updateRockets(dt) {
  State.rockets = State.rockets.filter(r => {
    if (!r.alive) { State.scene.remove(r.mesh); return false; }
    r.age += dt;
    if (r.age > 6) { State.scene.remove(r.mesh); return false; }
    r.pos.x += r.dir.x * ROCKET_SPEED * dt;
    r.pos.y += r.dir.y * ROCKET_SPEED * dt;
    r.pos.z += r.dir.z * ROCKET_SPEED * dt;

    let hit = false;
    Object.values(State.players).forEach(p => {
      if (!p.alive || !hit) return;
      if (p.id === r.ownerId && r.age < 0.4) return;
      const dx=p.pos.x-r.pos.x, dy=p.pos.y+0.5-r.pos.y, dz=p.pos.z-r.pos.z;
      if (Math.sqrt(dx*dx+dy*dy+dz*dz) < 1.5) hit = true;
    });

    if (!hit) {
      Object.values(State.players).forEach(p => {
        if (!p.alive) return;
        if (p.id === r.ownerId && r.age < 0.4) return;
        const dx=p.pos.x-r.pos.x, dy=(p.pos.y+0.5)-r.pos.y, dz=p.pos.z-r.pos.z;
        if (Math.sqrt(dx*dx+dy*dy+dz*dz) < 1.5) hit = true;
      });
    }

    const gy = getGroundY(r.pos.x, r.pos.z);
    if (r.pos.y <= gy + 0.2) hit = true;

    if (hit) {
      State.scene.remove(r.mesh);
      const ep = r.pos.clone();
      createExplosion(ep, r.ownerId === State.localId);
      if (r.ownerId === State.localId) relay({ type: 'explosion', x: ep.x, y: ep.y, z: ep.z });
      return false;
    }
    return true;
  });
}

function createExplosion(pos, applyForce) {
  const light = new THREE.PointLight(0xff6600, 20, 15);
  light.position.copy(pos); State.scene.add(light);
  const spheres = [];
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.18 + Math.random()*0.4, 6, 6),
      new THREE.MeshStandardMaterial({ color: Math.random()>0.5 ? 0xff4400 : 0xffaa00, emissive: 0xff2200, emissiveIntensity: 2 })
    );
    m.position.copy(pos);
    const d = new THREE.Vector3((Math.random()-0.5)*2, Math.random()+0.3, (Math.random()-0.5)*2).normalize().multiplyScalar(Math.random()*5+2);
    State.scene.add(m);
    spheres.push({ mesh: m, vel: d, age: 0 });
  }
  State.explosions.push({ pos, light, spheres, age: 0 });

  if (applyForce) {
    Object.values(State.players).forEach(p => {
      if (!p.alive) return;
      const dx=p.pos.x-pos.x, dy=p.pos.y-pos.y, dz=p.pos.z-pos.z;
      const dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (dist < EXPLOSION_RADIUS) {
        const f = (1 - dist/EXPLOSION_RADIUS) * EXPLOSION_FORCE;
        const nx = dist>0?dx/dist:0, ny = dist>0?dy/dist+0.4:0.5, nz = dist>0?dz/dist:0;
        if (p.id === State.localId) {
          p.vel.x += nx*f; p.vel.y += ny*f; p.vel.z += nz*f;
        } else {
          relay({ type: 'push', targetId: p.id, force: { x: nx*f, y: ny*f, z: nz*f } });
        }
      }
    });
  }
}

function updateExplosions(dt) {
  State.explosions = State.explosions.filter(exp => {
    exp.age += dt;
    exp.light.intensity = Math.max(0, 20 - exp.age * 40);
    if (exp.age > 0.5) State.scene.remove(exp.light);
    exp.spheres.forEach(s => {
      s.age += dt;
      s.vel.y += GRAVITY * dt * 0.5;
      s.mesh.position.x += s.vel.x*dt; s.mesh.position.y += s.vel.y*dt; s.mesh.position.z += s.vel.z*dt;
      s.mesh.scale.setScalar(Math.max(0, 1-s.age*2));
      s.mesh.material.opacity = Math.max(0, 1-s.age*2); s.mesh.material.transparent = true;
      if (s.age > 0.8) State.scene.remove(s.mesh);
    });
    return exp.age < 0.8;
  });
}

// ── COLLISION ─────────────────────────────────
function getGroundY(x, z) {
  for (const obj of State.groundObjects) {
    if (obj.type === 'box') {
      if (x >= obj.minX && x <= obj.maxX && z >= obj.minZ && z <= obj.maxZ) return obj.y;
    } else if (obj.type === 'ramp') {
      if (x >= obj.minX && x <= obj.maxX && z >= obj.minZ && z <= obj.maxZ) {
        const t = clamp((-z) / obj.rampLength, 0, 1);
        return lerp(obj.startY, obj.endY, t);
      }
    }
  }
  return -999;
}

// ── PLAYER UPDATE ─────────────────────────────
function updateLocalPlayer(dt) {
  const lp = State.players[State.localId];
  if (!lp || !lp.alive) return;
  if (lp.team === 'defenders') updateDefender(lp, dt);
  else updateCar(lp, dt);
  if (lp.pos.y < FALL_DEATH_Y) killPlayer(State.localId);
}

function updateDefender(p, dt) {
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const move = new THREE.Vector3();
  if (State.keys['KeyW']||State.keys['ArrowUp']) move.addScaledVector(forward,1);
  if (State.keys['KeyS']||State.keys['ArrowDown']) move.addScaledVector(forward,-1);
  if (State.keys['KeyA']||State.keys['ArrowLeft']) move.addScaledVector(right,-1);
  if (State.keys['KeyD']||State.keys['ArrowRight']) move.addScaledVector(right,1);
  if (move.lengthSq()>0) move.normalize().multiplyScalar(5);
  p.vel.x = lerp(p.vel.x, move.x, 0.25);
  p.vel.z = lerp(p.vel.z, move.z, 0.25);
  p.vel.y += GRAVITY * dt;
  const nx = p.pos.x + p.vel.x*dt, nz = p.pos.z + p.vel.z*dt;
  const gy = getGroundY(nx, nz);
  if (p.pos.y + p.vel.y*dt <= gy) {
    p.pos.y = gy; p.vel.y = 0; p.onGround = true;
    if (State.keys['Space'] && p.onGround) { p.vel.y = 7; p.onGround = false; }
  } else { p.pos.y += p.vel.y*dt; p.onGround = false; }
  p.pos.x = nx; p.pos.z = nz; p.rot.y = yaw;
  if (p.mesh) { p.mesh.position.set(p.pos.x,p.pos.y,p.pos.z); p.mesh.rotation.y = p.rot.y; }
}

function updateCar(p, dt) {
  let throttle = 0, steer = 0;
  if (State.keys['KeyW']||State.keys['ArrowUp']) throttle = 1;
  if (State.keys['KeyS']||State.keys['ArrowDown']) throttle = -0.5;
  if (State.keys['KeyA']||State.keys['ArrowLeft']) steer = 1;
  if (State.keys['KeyD']||State.keys['ArrowRight']) steer = -1;
  p.speed = clamp((p.speed||0) + throttle*22*dt, -CAR_SPEED*0.5, CAR_SPEED);
  p.speed *= 0.88;
  if (Math.abs(p.speed) > 0.2) p.rot.y += steer * CAR_TURN * dt * (p.speed/CAR_SPEED);
  const fwd = new THREE.Vector3(-Math.sin(p.rot.y), 0, -Math.cos(p.rot.y));
  p.vel.x = fwd.x * p.speed; p.vel.z = fwd.z * p.speed;
  p.vel.y += GRAVITY * dt;
  const nx = p.pos.x + p.vel.x*dt, nz = p.pos.z + p.vel.z*dt;
  const gy = getGroundY(nx, nz);
  if (p.pos.y + p.vel.y*dt <= gy+0.3) { p.pos.y = gy+0.3; p.vel.y = 0; p.onGround = true; }
  else { p.pos.y += p.vel.y*dt; p.onGround = false; }
  p.pos.x = nx; p.pos.z = nz;
  if (p.mesh) {
    p.mesh.position.set(p.pos.x,p.pos.y,p.pos.z);
    p.mesh.rotation.y = p.rot.y;
    if (p.pos.z > -RAMP_LENGTH && p.pos.z < 0 && p.onGround) {
      p.mesh.rotation.x = lerp(p.mesh.rotation.x, Math.atan2(RAMP_RISE, RAMP_LENGTH), 0.15);
    } else {
      p.mesh.rotation.x = lerp(p.mesh.rotation.x, 0, 0.15);
    }
  }
  document.getElementById('speed-bar-fill').style.width = (Math.abs(p.speed)/CAR_SPEED*100)+'%';
}

// ── CAMERA ────────────────────────────────────
function updateCamera() {
  const lp = State.players[State.localId];
  if (!lp) return;
  if (State.isDead) {
    const t = Date.now()*0.0003;
    State.camera.position.lerp(new THREE.Vector3(Math.sin(t)*25, 14, Math.cos(t)*25), 0.05);
    State.camera.lookAt(0, PLATFORM_Y, 0);
    return;
  }
  const target = new THREE.Vector3(lp.pos.x, lp.pos.y, lp.pos.z);
  if (lp.team === 'defenders') {
    const eye = new THREE.Vector3(lp.pos.x-Math.sin(yaw)*0.4, lp.pos.y+1.1, lp.pos.z-Math.cos(yaw)*0.4);
    State.camera.position.lerp(eye, 0.3);
    const ld = new THREE.Vector3(-Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw)*Math.cos(pitch));
    State.camera.lookAt(new THREE.Vector3().copy(eye).add(ld.multiplyScalar(10)));
  } else {
    const behind = new THREE.Vector3(lp.pos.x+Math.sin(lp.rot.y)*8, lp.pos.y+4, lp.pos.z+Math.cos(lp.rot.y)*8);
    State.camera.position.lerp(behind, 0.12);
    State.camera.lookAt(target.x, target.y+0.5, target.z);
  }
}

// ── KILL / WIN ────────────────────────────────
function killPlayer(id) {
  const p = State.players[id];
  if (!p || !p.alive) return;
  p.alive = false;
  if (p.mesh) p.mesh.visible = false;
  relay({ type: 'player_died', id });
  if (id === State.localId) {
    State.isDead = true; State.isSpectating = true;
    showEl('spectator-banner'); hideEl('controls-hint');
  }
  updateHUD();
  if (State.isHost) checkWinCondition();
}

function checkWinCondition() {
  const defs = Object.values(State.players).filter(p => p.team === 'defenders');
  const atks = Object.values(State.players).filter(p => p.team === 'attackers');
  if (defs.length>0 && defs.every(p=>!p.alive)) { broadcast({ type:'game_over', winTeam:'attackers' }); endGame('attackers'); }
  else if (atks.length>0 && atks.every(p=>!p.alive)) { broadcast({ type:'game_over', winTeam:'defenders' }); endGame('defenders'); }
}

function endGame(winTeam) {
  if (!State.gameRunning) return;
  State.gameRunning = false;
  const localTeam = State.players[State.localId]?.team;
  const won = localTeam === winTeam;
  document.getElementById('end-title').textContent = won ? 'VICTORY' : 'DEFEAT';
  document.getElementById('end-title').className = won ? 'win' : 'lose';
  document.getElementById('end-subtitle').textContent = winTeam === 'defenders' ? 'Defenders held the platform!' : 'Attackers knocked everyone off!';
  document.getElementById('end-overlay').classList.add('active');
}

// ── HUD ───────────────────────────────────────
function updateHUD() {
  const defs = Object.values(State.players).filter(p => p.team === 'defenders');
  const atks = Object.values(State.players).filter(p => p.team === 'attackers');
  document.getElementById('defenders-list').innerHTML = defs.map(p =>
    `<div class="player-pill ${p.alive?'alive':'dead'}"><div class="dot"></div>${p.name}${p.id===State.localId?' ★':''}</div>`).join('');
  document.getElementById('attackers-list').innerHTML = atks.map(p =>
    `<div class="player-pill ${p.alive?'alive':'dead'}"><div class="dot"></div>${p.name}${p.id===State.localId?' ★':''}</div>`).join('');
}

function updateRoleBanner() {
  const lp = State.players[State.localId];
  if (!lp) return;
  if (lp.team === 'defenders') {
    document.getElementById('role-banner').textContent = '🔴 DEFENDER — Hold the platform! Click to fire RPG.';
    document.getElementById('weapon-label').textContent = 'RPG · ROCKETS';
    document.getElementById('speed-bar-wrap').style.display = 'none';
  } else {
    document.getElementById('role-banner').textContent = '🔵 ATTACKER — Drive up the ramp and knock them off!';
    document.getElementById('weapon-label').textContent = 'CAR · NO WEAPONS';
    document.getElementById('ammo-bar').style.display = 'none';
    document.getElementById('speed-bar-wrap').style.display = 'flex';
  }
}

function updateAmmoBar() {
  const bar = document.getElementById('ammo-bar');
  bar.innerHTML = '';
  for (let i = 0; i < ROCKET_AMMO_MAX; i++) {
    const r = document.createElement('div');
    r.className = 'ammo-rocket' + (i < State.ammo ? '' : ' empty');
    bar.appendChild(r);
  }
  if (State.reloading) document.getElementById('weapon-label').textContent = 'RELOADING…';
  else document.getElementById('weapon-label').textContent = 'RPG · ROCKETS';
}

function updateTimerDisplay(t) {
  const sec = Math.max(0, Math.ceil(t));
  const timerEl = document.getElementById('round-timer');
  if (timerEl) {
    timerEl.textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
    timerEl.classList.toggle('low', sec <= 20);
  }
}

// ── TIMER (HOST) ──────────────────────────────
let timerAccum = 0;
function updateTimer(dt) {
  if (!State.isHost) return;
  State.roundTimer -= dt;
  updateTimerDisplay(State.roundTimer);
  timerAccum += dt;
  if (timerAccum > 2) { timerAccum = 0; broadcast({ type: 'timer', t: State.roundTimer }); }
  if (State.roundTimer <= 0) { broadcast({ type: 'game_over', winTeam: 'defenders' }); endGame('defenders'); }
}

// ── SYNC ──────────────────────────────────────
function sendSync() {
  const now = Date.now();
  if (now - State.lastSync < SYNC_RATE) return;
  State.lastSync = now;
  const lp = State.players[State.localId];
  if (!lp) return;
  const msg = { type: 'sync', id: State.localId, pos: {...lp.pos}, rot: {...lp.rot}, vel: {...lp.vel}, speed: lp.speed||0, alive: lp.alive, onGround: lp.onGround };
  relay(msg);
}

// ── GAME LOOP ─────────────────────────────────
function gameLoop() {
  const dt = Math.min(State.clock.getDelta(), 0.05);
  if (State.gameRunning) {
    updateTimer(dt);
    updateLocalPlayer(dt);
    updateRockets(dt);
    updateExplosions(dt);
    updateCamera();
    sendSync();
    if (State.isHost) updateHUD();
  }
  State.renderer.render(State.scene, State.camera);
}

console.log('🚗 RAMP WAR ready — host or join with a 6-letter code!');
