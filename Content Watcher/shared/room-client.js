export async function request(base, path, token, body, method = 'POST') {
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(15000), headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The room server could not complete this request.');
  return data;
}
export async function listen(base, room, token, onEvent, onError) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/rooms/${room}/events`, {
    headers: {Authorization: `Bearer ${token}`}, signal: controller.signal
  });
  if (!response.ok) throw new Error('This room has ended or your invite is invalid.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = '';
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) throw new Error('Disconnected from the room. Open the invite again to reconnect.');
        buffer += decoder.decode(value, {stream: true});
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const message = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (message.startsWith('data: ')) await onEvent(JSON.parse(message.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) onError(error); }
    finally { reader.releaseLock(); }
  })();
  return () => controller.abort();
}
export function candidateQueue(pc) {
  const pending = [];
  return {
    async add(candidate) { if (pc.remoteDescription) await pc.addIceCandidate(candidate); else pending.push(candidate); },
    async flush() { for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate); }
  };
}
