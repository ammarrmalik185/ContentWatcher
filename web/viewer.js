import {request, listen, candidateQueue} from '/shared/room-client.js';
const $ = selector => document.querySelector(selector);
const video = $('#video');
video.addEventListener('contextmenu', event => event.preventDefault());
const room = location.pathname.split('/').pop();
const invite = new URLSearchParams(location.hash.slice(1)).get('token');
let pc, token, stopListening, connectionTimer;
function cleanup() {
  clearTimeout(connectionTimer); stopListening?.(); stopListening = null;
  if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
  video.srcObject = null; video.classList.remove('playing');
  $('#sound').disabled = true; $('#placeholder').hidden = false;
}
function ended(message) {
  cleanup(); $('#status').textContent = 'Room ended'; $('#message').textContent = message; $('#join').hidden = true;
}
function error(error) {
  cleanup(); $('#status').textContent = 'Connection interrupted'; $('#error').textContent = error.message;
  $('#join').textContent = 'Try joining again'; $('#join').disabled = false;
}
async function signal(data) { await request('', `/api/rooms/${room}/signal`, token, {to: 'host', ...data}); }
$('#join').addEventListener('click', async () => {
  $('#join').disabled = true; $('#error').textContent = ''; $('#status').textContent = 'Connecting to your host…';
  try {
    const session = await request('', `/api/rooms/${room}/join`, invite, {});
    token = session.token;
    pc = new RTCPeerConnection({iceServers: session.iceServers});
    const queue = candidateQueue(pc);
    video.muted = true;
    pc.ontrack = async event => {
      video.srcObject = event.streams[0]; video.classList.add('playing');
      $('#placeholder').hidden = true; $('#sound').disabled = false;
      try { await video.play(); } catch { $('#sound').textContent = 'Start video & sound'; }
    };
    pc.onicecandidate = ({candidate}) => { if (candidate) signal({candidate}).catch(error); };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'connected') { clearTimeout(connectionTimer); $('#status').textContent = 'Live · watching together'; }
      if (pc?.connectionState === 'disconnected') $('#status').textContent = 'Connection interrupted · reconnecting…';
      if (pc?.connectionState === 'failed') error(new Error('Could not connect to your host. Try joining again, or ask the host to check their connection.'));
    };
    connectionTimer = setTimeout(() => error(new Error('Connection timed out. Try again or ask the host to check their connection.')), 30000);
    stopListening = await listen('', room, token, async message => {
      if (message.type === 'ended') return ended('Your host ended this room. Thanks for watching together.');
      if (message.type !== 'signal') return;
      if (message.description) {
        await pc.setRemoteDescription(message.description); await queue.flush();
        await pc.setLocalDescription(await pc.createAnswer());
        await signal({description: pc.localDescription});
      }
      if (message.candidate) await queue.add(message.candidate);
    }, error);
  } catch (e) { error(e); }
});
$('#sound').addEventListener('click', async () => {
  video.muted = !video.muted;
  try { await video.play(); $('#sound').textContent = video.muted ? 'Enable sound' : 'Mute sound'; }
  catch { $('#error').textContent = 'Your browser could not play the live stream. Try joining again.'; }
});
$('#volume').addEventListener('input', event => { video.volume = Number(event.target.value); });
$('#fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#stage').requestFullscreen(); }
  catch { $('#error').textContent = 'Fullscreen is unavailable in this browser.'; }
});
window.addEventListener('pagehide', cleanup);
if (!invite) ended('This invite is missing its private key. Ask your host for the complete link.');
