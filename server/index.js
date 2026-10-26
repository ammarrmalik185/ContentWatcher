import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const key = () => randomBytes(24).toString('base64url');
const json = (res, code, data) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };
const send = (res, data) => { if (res && !res.destroyed) { if (!res.write(`data: ${JSON.stringify(data)}\n\n`)) res.destroy(); } };
const fail = (code, message) => Object.assign(new Error(message), {code});
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 65536) throw fail(413, 'Request too large.');
  }
  try { return JSON.parse(text || '{}'); } catch { throw fail(400, 'Invalid JSON.'); }
}

export function createRoomServer({iceServers = [{urls: 'stun:stun.l.google.com:19302'}], maxGuests = 8, maxRooms = 100, roomLifetime = 6 * 60 * 60 * 1000} = {}) {
  const rooms = new Map();
  const limits = new Map();
  const files = {
    '/': ['../web/index.html', 'text/html'],
    '/viewer.js': ['../web/viewer.js', 'text/javascript'],
    '/styles.css': ['../Content Watcher/styles.css', 'text/css'],
    '/shared/room-client.js': ['../Content Watcher/shared/room-client.js', 'text/javascript']
  };
  function end(room) {
    rooms.delete(room.id);
    for (const res of [room.host, ...[...room.guests.values()].map(g => g.stream)]) {
      send(res, {type: 'ended'}); res?.end();
    }
  }
  function rate(req, category, count) {
    const id = `${req.socket.remoteAddress}:${category}`;
    let limit = limits.get(id);
    if (!limit || limit.until < Date.now()) { limit = {count: 0, until: Date.now() + 60000}; limits.set(id, limit); }
    if (++limit.count > count) throw fail(429, 'Too many requests. Try again in a minute.');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    // Extension access is opt-in through Chrome host permissions; API access also requires unguessable capabilities.
    const origin = req.headers.origin || '';
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && (files[path] || /^\/watch\/[A-Za-z0-9_-]{32}$/.test(path))) {
        const [file, type] = files[path] || ['../web/watch.html', 'text/html'];
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        res.end(await readFile(new URL(file, import.meta.url))); return;
      }
      if (path === '/api/rooms' && req.method === 'POST') {
        rate(req, 'create', 10);
        if (rooms.size >= maxRooms) throw fail(503, 'The room server is full. Try again later.');
        const room = {id: key(), hostToken: key(), guestToken: key(), guests: new Map(), created: Date.now(), host: null};
        rooms.set(room.id, room);
        json(res, 201, {id: room.id, hostToken: room.hostToken, guestToken: room.guestToken, iceServers}); return;
      }
      const match = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{32})(?:\/(join|events|signal))?$/);
      if (!match) throw fail(404, 'Not found.');
      const room = rooms.get(match[1]);
      if (!room) throw fail(404, 'This room has ended or does not exist.');
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const action = match[2];
      if (action === 'join' && req.method === 'POST') {
        rate(req, 'join', 30);
        if (token !== room.guestToken) throw fail(403, 'Invalid invite link.');
        if (!room.host) throw fail(409, 'The host is not connected. Try again shortly.');
        if (room.guests.size >= maxGuests) throw fail(409, 'This room is full.');
        const guest = {id: key(), token: key(), stream: null, created: Date.now()};
        room.guests.set(guest.id, guest);
        json(res, 201, {peerId: guest.id, token: guest.token, iceServers}); return;
      }
      const host = token === room.hostToken;
      const guest = [...room.guests.values()].find(g => g.token === token);
      if (!host && !guest) throw fail(403, 'You do not have access to this room.');
      if (!action && req.method === 'DELETE') {
        if (!host) throw fail(403, 'Only the host can end the room.');
        end(room); json(res, 200, {ok: true}); return;
      }
      if (action === 'events' && req.method === 'GET') {
        if (host ? room.host : guest.stream) throw fail(409, 'Already connected.');
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
        res.write(': connected\n\n');
        if (host) room.host = res;
        else { guest.stream = res; send(room.host, {type: 'joined', peerId: guest.id}); }
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => {
          clearInterval(heartbeat);
          if (!rooms.has(room.id)) return;
          if (host) end(room);
          else { room.guests.delete(guest.id); send(room.host, {type: 'left', peerId: guest.id}); }
        });
        return;
      }
      if (action === 'signal' && req.method === 'POST') {
        rate(req, 'signal', 2000);
        const data = await body(req);
        const target = host ? room.guests.get(data.to)?.stream : data.to === 'host' ? room.host : null;
        if (!target) throw fail(404, 'The other person has disconnected.');
        // No remote-control messages or guest-to-guest messages can pass this boundary.
        const message = {type: 'signal', from: host ? 'host' : guest.id};
        if (data.description) {
          if (data.description.type !== (host ? 'offer' : 'answer') || typeof data.description.sdp !== 'string') throw fail(400, 'Invalid session description.');
          message.description = {type: data.description.type, sdp: data.description.sdp};
        } else if (data.candidate && typeof data.candidate.candidate === 'string') {
          const {candidate, sdpMid, sdpMLineIndex, usernameFragment} = data.candidate;
          message.candidate = {candidate, sdpMid, sdpMLineIndex, usernameFragment};
        } else throw fail(400, 'Only connection setup messages are allowed.');
        send(target, message); json(res, 200, {ok: true}); return;
      }
      throw fail(405, 'Method not allowed.');
    } catch (error) {
      if (!res.headersSent) json(res, error.code || 500, {error: error.code ? error.message : 'The room server encountered an error.'});
      else res.end();
    }
  });
  const sweep = setInterval(() => {
    for (const room of rooms.values()) {
      if (Date.now() - room.created > roomLifetime || (!room.host && Date.now() - room.created > 30000)) { end(room); continue; }
      for (const guest of room.guests.values()) if (!guest.stream && Date.now() - guest.created > 30000) room.guests.delete(guest.id);
    }
    for (const [id, limit] of limits) if (limit.until < Date.now()) limits.delete(id);
  }, 10000).unref();
  server.on('close', () => { clearInterval(sweep); for (const room of rooms.values()) end(room); });
  server.endRooms = () => { for (const room of rooms.values()) end(room); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const iceServers = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : undefined;
  const server = createRoomServer({iceServers});
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '0.0.0.0', () => console.log(`Content Watcher room server listening on port ${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.endRooms(); server.close(); });
}
