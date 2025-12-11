import http from 'http';
import { WebSocketServer } from 'ws';
import url from 'url';

const PORT = process.env.PORT || 10000;

const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 دقیقه

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Maze Race WS server is running\n');
});

const wss = new WebSocketServer({ noServer: true });

/**
 * rooms: Map<roomId, {
 *   roomId: string,
 *   password: string | null,
 *   maxPlayers: number,
 *   players: Array<{ playerId, ws, x, y }>,
 *   seed: number,
 *   w: number,
 *   h: number,
 *   winner: string | null,
 *   lastActivity: number
 * }>
 */
const rooms = new Map();

/** playerId → { roomId, playerIndex } */
const playerIndexMap = new Map();

function now() {
  return Date.now();
}

function touchRoom(room) {
  room.lastActivity = now();
}

function broadcastRoomState(room) {
  const payload = {
    type: 'state',
    players: room.players.map(p => ({ id: p.playerId, x: p.x, y: p.y })),
    winner: room.winner || null
  };
  const msg = JSON.stringify(payload);
  room.players.forEach(p => {
    if (p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  });
}

function sendRoomList(ws) {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    list.push({
      roomId: id,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      hasPassword: !!room.password
    });
  }
  ws.send(JSON.stringify({ type: 'roomList', rooms: list }));
}

function cleanupRooms() {
  const t = now();
  for (const [id, room] of rooms.entries()) {
    if (room.players.length === 0) {
      rooms.delete(id);
      console.log('Room deleted (empty):', id);
      continue;
    }
    if (t - room.lastActivity > INACTIVITY_TIMEOUT) {
      console.log('Room deleted (inactive):', id);
      room.players.forEach(p => {
        if (p.ws.readyState === 1) {
          p.ws.send(JSON.stringify({ type: 'roomClosed', reason: 'inactive' }));
          p.ws.close();
        }
      });
      rooms.delete(id);
    }
  }
}

setInterval(cleanupRooms, 60 * 1000); // هر 1 دقیقه چک کن

server.on('upgrade', (request, socket, head) => {
  const { pathname } = url.parse(request.url);
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const playerId = Math.random().toString(36).slice(2);
  console.log('Client connected:', playerId);

  ws.send(JSON.stringify({ type: 'welcome', playerId }));
  sendRoomList(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch {
      console.log('Bad JSON from', playerId, '=>', raw.toString());
      return;
    }

    if (msg.type === 'createRoom') {
      const roomId = msg.roomId;
      const password = msg.password ? String(msg.password) : null;
      let maxPlayers = Number(msg.maxPlayers) || 2;
      if (maxPlayers < 1) maxPlayers = 1;
      if (maxPlayers > 8) maxPlayers = 8;

      if (rooms.has(roomId)) {
        ws.send(JSON.stringify({ type: 'error', reason: 'room_already_exists' }));
        return;
      }

      const seed = Math.floor(Math.random() * 1e9);
      const w = 41, h = 41;

      const room = {
        roomId,
        password,
        maxPlayers,
        players: [],
        seed,
        w,
        h,
        winner: null,
        lastActivity: now()
      };

      const player = { playerId, ws, x: 1, y: 1 };
      room.players.push(player);
      rooms.set(roomId, room);
      playerIndexMap.set(playerId, { roomId, playerIndex: 0 });

      console.log('createRoom:', roomId, 'by', playerId, 'maxPlayers:', maxPlayers);
      ws.send(JSON.stringify({
        type: 'roomCreated',
        roomId,
        maxPlayers,
        hasPassword: !!password
      }));
      sendRoomListToAll();
    }

    else if (msg.type === 'joinRoom') {
      const roomId = msg.roomId;
      const password = msg.password || null;
      const rejoinPlayerId = msg.playerId || playerId;

      const room = rooms.get(roomId);
      console.log('joinRoom:', roomId, 'by', playerId, 'as', rejoinPlayerId, 'roomExists?', !!room);

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', reason: 'room_not_found' }));
        return;
      }

      if (room.password && room.password !== password) {
        ws.send(JSON.stringify({ type: 'error', reason: 'wrong_password' }));
        return;
      }

      // Rejoin
      let existingIndex = room.players.findIndex(p => p.playerId === rejoinPlayerId);
      if (existingIndex !== -1) {
        room.players[existingIndex].ws = ws;
        playerIndexMap.set(rejoinPlayerId, { roomId, playerIndex: existingIndex });
        ws.send(JSON.stringify({
          type: 'roomJoined',
          roomId,
          rejoin: true,
          playerIndex: existingIndex
        }));

        // دوباره start برای این بازیکن
        ws.send(JSON.stringify({
          type: 'start',
          seed: room.seed,
          w: room.w,
          h: room.h,
          playerIndex: existingIndex
        }));

        touchRoom(room);
        return;
      }

      // Join جدید
      if (room.players.length >= room.maxPlayers) {
        ws.send(JSON.stringify({ type: 'error', reason: 'room_full' }));
        return;
      }

      const newIndex = room.players.length;
      const player = { playerId, ws, x: 1, y: 1 + newIndex };
      room.players.push(player);
      playerIndexMap.set(playerId, { roomId, playerIndex: newIndex });
      touchRoom(room);

      ws.send(JSON.stringify({
        type: 'roomJoined',
        roomId,
        rejoin: false,
        playerIndex: newIndex
      }));

      // برای همه‌ی بازیکن‌های اتاق start بفرست
      room.players.forEach((p, idx) => {
        if (p.ws.readyState === 1) {
          p.ws.send(JSON.stringify({
            type: 'start',
            seed: room.seed,
            w: room.w,
            h: room.h,
            playerIndex: idx
          }));
        }
      });
    }

    else if (msg.type === 'move') {
      const info = playerIndexMap.get(playerId);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room) return;

      const p = room.players[info.playerIndex];
      if (!p) return;

      p.x = msg.payload.x;
      p.y = msg.payload.y;
      touchRoom(room);
      broadcastRoomState(room);
    }

    else if (msg.type === 'win') {
      const info = playerIndexMap.get(playerId);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room) return;

      if (!room.winner) {
        room.winner = playerId;
        touchRoom(room);
        broadcastRoomState(room);
      }
    }

    else if (msg.type === 'getRooms') {
      sendRoomList(ws);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected:', playerId);

    // پاک کردن از playerIndexMap، حذف از rooms اگر ws قطع شد
    const info = playerIndexMap.get(playerId);
    if (!info) return;

    const room = rooms.get(info.roomId);
    if (!room) {
      playerIndexMap.delete(playerId);
      return;
    }

    // ws رو فقط قطع شده علامت می‌زنیم، ولی playerId می‌مونه برای rejoin
    room.players[info.playerIndex].ws = { readyState: 3 }; // CLOSED

    // اگر همه قطع شده‌ن، بعد از timeout پاک می‌شه
    playerIndexMap.delete(playerId);
  });
});

function sendRoomListToAll() {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    list.push({
      roomId: id,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      hasPassword: !!room.password
    });
  }
  const msg = JSON.stringify({ type: 'roomList', rooms: list });
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
}

server.listen(PORT, () => {
  console.log(`WS server on :${PORT} (path /ws)`);
});
