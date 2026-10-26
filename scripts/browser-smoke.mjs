// Optional real-browser smoke test. Uses a synthetic source instead of Chrome's permission-gated tabCapture API.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRoomServer} from '../server/index.js';

const executable = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = await mkdtemp(path.join(tmpdir(), 'content-watcher-smoke-'));
const server = createRoomServer();
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const fixtureFiles = {
  '/host.html': '../Content Watcher/host.html', '/host.js': '../Content Watcher/host.js',
  '/popup.html': '../Content Watcher/popup.html', '/popup.js': '../Content Watcher/popup.js'
};
const proxy = http.createServer(async (req, res) => {
  const file = fixtureFiles[new URL(req.url, 'http://localhost').pathname];
  if (file) {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(new URL(file, import.meta.url))); return;
  }
  const outgoing = http.request({hostname: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers: req.headers}, incoming => {
    res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
    res.on('close', () => outgoing.destroy());
  });
  outgoing.on('error', () => res.destroy()); req.pipe(outgoing);
});
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const base = `http://127.0.0.1:${proxy.address().port}`;
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
let browserLog = '';
browser.stderr.on('data', chunk => { browserLog += chunk; });
browser.on('error', e => console.error(e.message));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let debug, browserSocket;
const clients = [];
async function waitFor(fn, label) {
  for (let attempt = 0; attempt < 150; attempt++) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function connect(url) {
  const ws = new WebSocket(url); await once(ws, 'open'); let id = 0;
  const pending = new Map(); const errors = [];
  ws.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    const task = pending.get(message.id);
    if (task) { pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
  });
  ws.addEventListener('close', () => { for (const task of pending.values()) task.reject(new Error('Browser connection closed.')); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, {resolve, reject}); ws.send(JSON.stringify({id, method, params})); });
  clients.push(ws);
  return {send, errors, evaluate: async expression => {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }};
}
async function page(url, init) {
  const target = await (await fetch(`${debug}/json/new?about:blank`, {method: 'PUT'})).json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  if (init) await client.send('Page.addScriptToEvaluateOnNewDocument', {source: init});
  await client.send('Page.navigate', {url});
  await waitFor(() => client.evaluate('document.readyState === "complete"'), 'page load');
  return client;
}
try {
  const portFile = await waitFor(() => readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => ''), 'headless browser start');
  debug = `http://127.0.0.1:${portFile.split('\n')[0]}`;
  console.log('Headless browser ready.');
  const version = await (await fetch(debug + '/json/version')).json();
  browserSocket = await connect(version.webSocketDebuggerUrl);
  const init = `
    window.chrome = {tabCapture: {getMediaStreamId: async () => 'synthetic'}, tabs: {update: async () => {}}};
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d');
      function frame() { context.fillStyle = '#294b39'; context.fillRect(0, 0, 1280, 720); context.fillStyle = '#d4f78c'; context.font = '60px sans-serif'; context.fillText('Watch together · ' + Math.floor(performance.now() / 1000), 100, 360); }
      frame(); setInterval(frame, 100);
      const stream = canvas.captureStream(10);
      const audio = new AudioContext(); const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]); return stream;
    };
  `;
  const host = await page(`${base}/host.html?tab=1&server=${encodeURIComponent(base)}`, init);
  console.log('Host loaded.');
  await host.evaluate('document.querySelector("#start").click()');
  const invite = await waitFor(() => host.evaluate('document.querySelector("#link").value'), 'host invite');
  console.log('Room created.');
  const guest = await page(invite);
  await guest.evaluate('document.querySelector("#join").click()');
  await waitFor(() => guest.evaluate('document.querySelector("#video").videoWidth > 0'), 'guest receives live video');
  console.log('Guest receiving live video.');
  await waitFor(() => host.evaluate('document.querySelector("#count").textContent === "1 watching"'), 'host guest count');
  assert.equal(await guest.evaluate('document.querySelector("#video").controls'), false);
  assert.equal(await guest.evaluate('document.querySelector("#video").muted'), true);
  const before = await guest.evaluate('document.querySelector("#video").currentTime');
  await delay(500);
  assert.ok(await guest.evaluate('document.querySelector("#video").currentTime') > before, 'live playback progresses');
  await guest.evaluate('document.querySelector("#sound").click()');
  assert.equal(await guest.evaluate('document.querySelector("#video").muted'), false);
  await guest.evaluate('document.querySelector("#volume").value = "0.5"; document.querySelector("#volume").dispatchEvent(new Event("input"))');
  assert.equal(await guest.evaluate('document.querySelector("#video").volume'), 0.5);
  await mkdir('artifacts', {recursive: true});
  for (const [name, client] of [['host', host], ['guest', guest]]) {
    const capture = await client.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
    await writeFile(`artifacts/${name}.png`, Buffer.from(capture.data, 'base64'));
    await client.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    assert.equal(await client.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${name} fits mobile viewport`);
    const mobile = await client.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
    await writeFile(`artifacts/${name}-mobile.png`, Buffer.from(mobile.data, 'base64'));
  }
  await host.evaluate('document.querySelector("#stop").click()');
  await waitFor(() => guest.evaluate('document.querySelector("#status").textContent === "Room ended"'), 'host ends room');
  assert.equal(await guest.evaluate('document.querySelector("#video").srcObject'), null);
  assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
  console.log('Browser smoke passed: live WebRTC video, guest count, read-only player, audio toggle, volume, responsive layout, and room end. Screenshots: artifacts/.');
} catch (error) { console.error(error); console.error(browserLog); process.exitCode = 1; }
finally {
  try { await Promise.race([browserSocket?.send('Browser.close'), delay(2000)]); } catch {}
  clients.forEach(ws => ws.close());
  if (browser.exitCode === null) browser.kill();
  server.endRooms(); proxy.closeAllConnections(); server.closeAllConnections();
  await Promise.race([Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => server.close(resolve))]), delay(2000)]);
  // Only remove this test's unique temporary browser profile, never a user's browser data.
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('content-watcher-smoke-')) await rm(resolved, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}).catch(() => {});
}
