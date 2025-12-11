import http from 'http';
import { WebSocketServer } from 'ws';
import url from 'url';

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Maze Race WS server is running\n');
});

const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();

function broadcastRoomState(room) {
  const payload = {
    type: 'state',
    players: room.players.map(p => ({ id: p.id, x: p.x, y: p.y })),
    winner: room.winner || null
  };
  const msg = JSON.stringify(payload);
  room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(msg); });
}

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
  const id = Math.random().toString(36).slice(2);
  console.log('Client connected:', id);
  ws.send(JSON.stringify({ type: 'welcome', id }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch {
      console.log('Bad JSON from', id, '=>', raw.toString());
      return;
    }

    if (msg.type === 'createRoom') {
      const roomId = msg.roomId;
      const seed = Math.floor(Math.random() * 1e9);
      const w = 41, h = 41;
      rooms.set(roomId, { players: [{ id, ws, x: 1, y: 1 }], seed, w, h, winner: null });
      console.log('createRoom:', roomId, 'by', id);
      ws.send(JSON.stringify({ type: 'roomCreated', roomId }));
    }

    else if (msg.type === 'joinRoom') {
      const roomId = msg.roomId;
      const room = rooms.get(roomId);
      console.log('joinRoom:', roomId, 'by', id, 'roomExists?', !!room);
      if (!room || room.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', reason: 'room_not_found_or_full' }));
        return;
      }
      room.players.push({ id, ws, x: 1, y: 2 });
      ws.send(JSON.stringify({ type: 'roomJoined', roomId }));

      room.players.forEach((p, idx) => {
        p.ws.send(JSON.stringify({
          type: 'start',
          seed: room.seed,
          w: room.w,
          h: room.h,
          playerIndex: idx
        }));
      });
    }

    else if (msg.type === 'move') {
      const room = [...rooms.values()].find(r => r.players.some(p => p.id === id));
      if (!room) {
        console.log('move from', id, 'but no room found');
        return;
      }
      const p = room.players.find(p => p.id === id);
      if (!p) return;
      p.x = msg.payload.x;
      p.y = msg.payload.y;
      broadcastRoomState(room);
    }

    else if (msg.type === 'win') {
      const room = [...rooms.values()].find(r => r.players.some(p => p.id === id));
      if (!room || room.winner) return;
      room.winner = id;
      broadcastRoomState(room);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected:', id);
    for (const [rid, room] of rooms.entries()) {
      room.players = room.players.filter(p => p.id !== id);
      if (room.players.length === 0) {
        rooms.delete(rid);
        console.log('Room deleted:', rid);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`WS server on :${PORT} (path /ws)`);
});
