import {request, listen, candidateQueue} from './shared/room-client.js';
const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const base = params.get('server');
const tabId = Number(params.get('tab'));
const peers = new Map();
let stream, audio, room, stopListening, stopping = false;
const status = message => { $('#status').textContent = message; };
function count() { const n = [...peers.values()].filter(p => p.pc.connectionState === 'connected').length; $('#count').textContent = `${n} watching`; if (room) status(n ? 'Live · watching together' : 'Live · waiting for friends'); }
function remove(id) { peers.get(id)?.pc.close(); peers.delete(id); count(); }
async function signal(to, data) { await request(base, `/api/rooms/${room.id}/signal`, room.hostToken, {to, ...data}); }
async function event(message) {
  if (message.type === 'joined') {
    remove(message.peerId);
    const pc = new RTCPeerConnection({iceServers: room.iceServers});
    const queue = candidateQueue(pc);
    peers.set(message.peerId, {pc, queue});
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.onicecandidate = ({candidate}) => { if (candidate) signal(message.peerId, {candidate}).catch(fail); };
    pc.onconnectionstatechange = () => { count(); if (pc.connectionState === 'failed') remove(message.peerId); };
    await pc.setLocalDescription(await pc.createOffer());
    await signal(message.peerId, {description: pc.localDescription});
  } else if (message.type === 'left') remove(message.peerId);
  else if (message.type === 'signal') {
    const peer = peers.get(message.from);
    if (!peer) return;
    if (message.description) { await peer.pc.setRemoteDescription(message.description); await peer.queue.flush(); }
    if (message.candidate) await peer.queue.add(message.candidate);
  } else if (message.type === 'ended') await stop();
}
function fail(error) { $('#error').textContent = error.message; }
async function stop() {
  if (stopping) return;
  stopping = true;
  if (room) await request(base, `/api/rooms/${room.id}`, room.hostToken, undefined, 'DELETE').catch(() => {});
  stopListening?.();
  peers.forEach(({pc}) => pc.close()); peers.clear(); count();
  stream?.getTracks().forEach(track => track.stop());
  await audio?.close().catch(() => {});
  $('#preview').srcObject = null; $('#preview').classList.remove('playing');
  $('#placeholder').hidden = false; $('#invite').hidden = true;
  $('#stop').disabled = true; $('#start').disabled = false;
  status('Room ended'); room = null; stopping = false;
}
$('#start').addEventListener('click', async () => {
  $('#start').disabled = true; $('#error').textContent = '';
  try {
    status('Starting tab capture…');
    audio = new AudioContext(); await audio.resume();
    const id = await chrome.tabCapture.getMediaStreamId({targetTabId: tabId});
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: id}},
      video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30}}
    });
    if (stream.getAudioTracks().length) audio.createMediaStreamSource(stream).connect(audio.destination);
    stream.getVideoTracks()[0].addEventListener('ended', () => void stop());
    $('#preview').srcObject = stream; $('#preview').classList.add('playing'); $('#placeholder').hidden = true;
    room = await request(base, '/api/rooms', null, {});
    stopListening = await listen(base, room.id, room.hostToken, event, error => { fail(error); void stop(); });
    $('#link').value = `${base}/watch/${room.id}#token=${room.guestToken}`;
    $('#invite').hidden = false; $('#stop').disabled = false; status('Live · waiting for friends');
  } catch (error) { fail(new Error(`${error.message} Check that the room server is running and the source tab is still open.`)); await stop(); }
});
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#link').value); $('#copy').textContent = 'Link copied'; setTimeout(() => { $('#copy').textContent = 'Copy invite link'; }, 2000); }
  catch { $('#link').select(); fail(new Error('Select and copy the invite link above.')); }
});
$('#source').addEventListener('click', () => chrome.tabs.update(tabId, {active: true}).catch(fail));
$('#stop').addEventListener('click', stop);
window.addEventListener('pagehide', () => { stopListening?.(); stream?.getTracks().forEach(track => track.stop()); });
