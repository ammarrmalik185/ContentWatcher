import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRoomServer} from '../server/index.js';

async function fixture(t, options) {
  const server = createRoomServer(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.endRooms(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = async (path, token, body, method = 'POST') => {
    const res = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: res.status, data: await res.json()};
  };
  const room = (await call('/api/rooms', null, {})).data;
  const route = `/api/rooms/${room.id}`;
  const events = async token => {
    const abort = new AbortController();
    const response = await fetch(base + route + '/events', {headers: {Authorization: `Bearer ${token}`}, signal: abort.signal});
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); let buffer = '';
    const next = async () => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
          continue;
        }
        const result = await reader.read();
        if (result.done) return null;
        buffer += new TextDecoder().decode(result.value);
      }
    };
    t.after(() => abort.abort());
    return {next, close: () => abort.abort()};
  };
  return {base, call, room, route, events};
}

test('host and multiple guests exchange setup; guests cannot control playback or other guests', {timeout: 10000}, async t => {
  const {call, room, route, events} = await fixture(t);
  const host = await events(room.hostToken);
  const first = (await call(route + '/join', room.guestToken, {})).data;
  const guest = await events(first.token);
  assert.deepEqual(await host.next(), {type: 'joined', peerId: first.peerId});
  const second = (await call(route + '/join', room.guestToken, {})).data;
  const guest2 = await events(second.token);
  assert.equal((await host.next()).peerId, second.peerId);
  assert.equal((await call(route + '/signal', room.hostToken, {to: first.peerId, description: {type: 'offer', sdp: 'offer'}})).status, 200);
  assert.equal((await guest.next()).description.sdp, 'offer');
  assert.equal((await call(route + '/signal', first.token, {to: 'host', description: {type: 'answer', sdp: 'answer'}})).status, 200);
  assert.equal((await host.next()).description.sdp, 'answer');
  assert.equal((await call(route + '/signal', first.token, {to: 'host', candidate: {candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0}})).status, 200);
  assert.equal((await host.next()).candidate.candidate, 'candidate:1');
  assert.equal((await call(route + '/signal', first.token, {to: second.peerId, description: {type: 'answer', sdp: 'x'}})).status, 404);
  assert.equal((await call(route + '/signal', first.token, {to: 'host', command: 'seek', time: 120})).status, 400);
  assert.equal((await call(route + '/signal', first.token, {to: 'host', description: {type: 'offer', sdp: 'x'}})).status, 400);
  assert.equal((await call(route, first.token, undefined, 'DELETE')).status, 403);
  assert.equal((await call(route, room.hostToken, undefined, 'DELETE')).status, 200);
  assert.equal((await guest.next()).type, 'ended');
  assert.equal((await guest2.next()).type, 'ended');
  assert.equal((await call(route + '/join', room.guestToken, {})).status, 404);
});

test('invalid invites, unauthenticated access, duplicate streams and room capacity are rejected', {timeout: 10000}, async t => {
  const {call, room, route, events} = await fixture(t, {maxGuests: 1});
  assert.equal((await call(route + '/join', room.guestToken, {})).status, 409);
  await events(room.hostToken);
  assert.equal((await call(route + '/join', 'wrong', {})).status, 403);
  assert.equal((await call(route, undefined, undefined, 'DELETE')).status, 403);
  assert.equal((await call(route + '/events', room.guestToken, undefined, 'GET')).status, 403);
  const guest = (await call(route + '/join', room.guestToken, {})).data;
  assert.ok(guest.token && guest.token !== room.guestToken);
  assert.equal((await call(route + '/join', room.guestToken, {})).status, 409);
  assert.equal((await call(route + '/events', room.hostToken, undefined, 'GET')).status, 409);
});

test('closing the host connection ends the room and informs guests', {timeout: 10000}, async t => {
  const {call, room, route, events} = await fixture(t);
  const host = await events(room.hostToken);
  const session = (await call(route + '/join', room.guestToken, {})).data;
  const guest = await events(session.token);
  await host.next(); host.close();
  assert.equal((await guest.next()).type, 'ended');
  assert.equal((await call(route + '/join', room.guestToken, {})).status, 404);
});

test('guest disconnect removes them and notifies the host', {timeout: 10000}, async t => {
  const {call, room, route, events} = await fixture(t);
  const host = await events(room.hostToken);
  const session = (await call(route + '/join', room.guestToken, {})).data;
  const guest = await events(session.token);
  await host.next(); guest.close();
  assert.deepEqual(await host.next(), {type: 'left', peerId: session.peerId});
  assert.equal((await call(route + '/signal', session.token, {to: 'host', candidate: {candidate: 'x'}})).status, 403);
});

test('only public guest assets are served and extension preflights are supported', async t => {
  const {base, call} = await fixture(t);
  for (const path of ['/', '/styles.css', '/viewer.js', '/shared/room-client.js', `/watch/${'a'.repeat(32)}`]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200); assert.ok(response.headers.get('content-security-policy')); await response.text();
  }
  assert.equal((await call('/host.js', null, undefined, 'GET')).status, 404);
  assert.equal((await call('/server/index.js', null, undefined, 'GET')).status, 404);
  const response = await fetch(base + '/api/rooms', {method: 'OPTIONS', headers: {Origin: `chrome-extension://${'a'.repeat(32)}`}});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), `chrome-extension://${'a'.repeat(32)}`);
});

test('capacity and body-size limits protect signaling resources', {timeout: 10000}, async t => {
  const {call, route, room, events} = await fixture(t, {maxRooms: 1});
  assert.equal((await call('/api/rooms', null, {})).status, 503);
  const host = await events(room.hostToken);
  const session = (await call(route + '/join', room.guestToken, {})).data;
  await events(session.token); await host.next();
  assert.equal((await call(route + '/signal', room.hostToken, {to: session.peerId, description: {type: 'offer', sdp: 'x'.repeat(70000)}})).status, 413);
});
