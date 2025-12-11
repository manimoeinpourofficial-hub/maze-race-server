// ----- تنظیمات پایه
const cell = 20;
const wsUrl = "wss://maze-race-server.onrender.com/ws";

let ws, maze, me, other, myId;
let isConnected = false;

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const statusEl = document.getElementById('status');
const roomInput = document.getElementById('roomId');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');

// ----- PRNG و تولید هزارتو
function mulberry32(seed){
  return function(){
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateMaze(w, h, seed){
  const rnd = mulberry32(seed);
  const grid = Array.from({length: h}, () => Array(w).fill(1));
  const dirs = [[0,-2],[0,2],[-2,0],[2,0]];
  const sx = 1, sy = 1;
  grid[sy][sx] = 0;

  function shuffle(a){
    for (let i = a.length - 1; i > 0; i--){
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function carve(x, y){
    shuffle(dirs).forEach(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (
        ny > 0 && ny < h - 1 &&
        nx > 0 && nx < w - 1 &&
        grid[ny][nx] === 1
      ) {
        grid[y + dy / 2][x + dx / 2] = 0;
        grid[ny][nx] = 0;
        carve(nx, ny);
      }
    });
  }

  carve(sx, sy);

  return {
    grid,
    start: { x: 1, y: 1 },
    exit: { x: w - 2, y: h - 2 }
  };
}

// ----- حرکت و برخورد
function canMove(x, y){
  return maze && maze.grid[y]?.[x] === 0;
}

function tryMove(p, dx, dy){
  const nx = p.x + dx;
  const ny = p.y + dy;
  if (canMove(nx, ny)){
    p.x = nx;
    p.y = ny;
  }
}

// ----- رندر
function draw(){
  if (!maze || !maze.grid) return;

  ctx.clearRect(0, 0, cv.width, cv.height);

  // دیوارها و راه‌ها
  for (let y = 0; y < maze.grid.length; y++){
    for (let x = 0; x < maze.grid[0].length; x++){
      ctx.fillStyle = maze.grid[y][x] ? '#333' : '#111';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // خروج
  ctx.fillStyle = '#3c3';
  ctx.fillRect(maze.exit.x * cell, maze.exit.y * cell, cell, cell);

  // خودت
  if (me){
    ctx.fillStyle = me.color;
    ctx.beginPath();
    ctx.arc(
      me.x * cell + cell / 2,
      me.y * cell + cell / 2,
      cell * 0.4,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // حریف
  if (other){
    ctx.fillStyle = other.color;
    ctx.beginPath();
    ctx.arc(
      other.x * cell + cell / 2,
      other.y * cell + cell / 2,
      cell * 0.4,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
}

// ----- حلقه بازی
function loop(){
  draw();
  requestAnimationFrame(loop);
}

// ----- ارسال به سرور
function send(obj){
  if (ws && ws.readyState === 1){
    ws.send(JSON.stringify(obj));
  } else {
    console.log('WS NOT READY, drop message:', obj);
  }
}

// ----- کنترل لمسی (موبایل)
cv.addEventListener('touchstart', handleTouch, { passive: false });
cv.addEventListener('touchmove', handleTouch, { passive: false });

function handleTouch(e){
  e.preventDefault();
  if (!me || !maze) return;

  const touch = e.touches[0];
  const rect = cv.getBoundingClientRect();
  const tx = touch.clientX - rect.left;
  const ty = touch.clientY - rect.top;

  const px = me.x * cell + cell / 2;
  const py = me.y * cell + cell / 2;

  const dx = tx - px;
  const dy = ty - py;

  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx > 0) tryMove(me, 1, 0);
    else        tryMove(me, -1, 0);
  } else {
    if (dy > 0) tryMove(me, 0, 1);
    else        tryMove(me, 0, -1);
  }

  send({ type: 'move', payload: { x: me.x, y: me.y } });

  if (me.x === maze.exit.x && me.y === maze.exit.y){
    send({ type: 'win' });
  }
}

// ----- کنترل کیبورد (کامپیوتر)
document.addEventListener('keydown', (e) => {
  if (!me || !maze) return;

  let moved = false;

  if (e.key === 'ArrowUp' || e.key === 'w')    { tryMove(me, 0, -1); moved = true; }
  if (e.key === 'ArrowDown' || e.key === 's')  { tryMove(me, 0, 1);  moved = true; }
  if (e.key === 'ArrowLeft' || e.key === 'a')  { tryMove(me, -1, 0); moved = true; }
  if (e.key === 'ArrowRight' || e.key === 'd') { tryMove(me, 1, 0);  moved = true; }

  if (!moved) return;

  send({ type: 'move', payload: { x: me.x, y: me.y } });

  if (me.x === maze.exit.x && me.y === maze.exit.y){
    send({ type: 'win' });
  }
});

// ----- اتصال به WebSocket
function connect(){
  ws = new WebSocket(wsUrl);
  statusEl.textContent = 'در حال اتصال به سرور...';

  ws.onopen = () => {
    isConnected = true;
    statusEl.textContent = 'وصل شد. یک اتاق بساز یا وارد شو.';
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    console.log('WS MSG:', msg);

    if (msg.type === 'welcome'){
      myId = msg.id;
      console.log('My id:', myId);
    }

    if (msg.type === 'roomCreated'){
      statusEl.textContent = `اتاق ساخته شد: ${msg.roomId}`;
      roomInput.value = msg.roomId;   // اتومات در input بذار برای دستگاه دوم
    }

    if (msg.type === 'roomJoined'){
      statusEl.textContent = `ورود به اتاق: ${msg.roomId}`;
    }

    if (msg.type === 'start'){
      maze = generateMaze(msg.w, msg.h, msg.seed);
      const p1 = maze.start;
      const p2 = { x: maze.start.x, y: maze.start.y + 1 };
      const isP1 = (msg.playerIndex === 0);

      me = {
        x: isP1 ? p1.x : p2.x,
        y: isP1 ? p1.y : p2.y,
        color: isP1 ? '#39f' : '#f93'
      };

      other = {
        x: isP1 ? p2.x : p1.x,
        y: isP1 ? p2.y : p1.y,
        color: isP1 ? '#f93' : '#39f'
      };

      statusEl.textContent = 'بازی شروع شد!';
    }

    if (msg.type === 'state'){
      const o = msg.players.find(p => p.id !== myId);
      if (o && other){
        other.x = o.x;
        other.y = o.y;
      }
      if (msg.winner){
        statusEl.textContent = (msg.winner === myId) ? 'بردی!' : 'حریف برد';
      }
    }

    if (msg.type === 'error'){
      statusEl.textContent = 'اتاق پیدا نشد یا پر است';
    }
  };

  ws.onclose = () => {
    isConnected = false;
    statusEl.textContent = 'ارتباط قطع شد';
  };
}

// ----- دکمه‌ها (ساخت/ورود اتاق)
createBtn.onclick = () => {
  if (!isConnected){
    statusEl.textContent = 'هنوز به سرور وصل نشدی';
    return;
  }
  const rid = Math.random().toString(36).slice(2, 7);
  roomInput.value = rid;
  send({ type: 'createRoom', roomId: rid });
};

joinBtn.onclick = () => {
  if (!isConnected){
    statusEl.textContent = 'هنوز به سرور وصل نشدی';
    return;
  }
  const rid = roomInput.value.trim();
  if (!rid){
    statusEl.textContent = 'کد اتاق را وارد کن';
    return;
  }
  send({ type: 'joinRoom', roomId: rid });
};

// ----- شروع بازی
connect();
requestAnimationFrame(loop);
