const server = document.querySelector('#server');
const start = document.querySelector('#start');
const status = document.querySelector('#status');
const saved = await chrome.storage.local.get('server');
if (saved.server) server.value = saved.server;
start.addEventListener('click', async () => {
  start.disabled = true;
  try {
    const url = new URL(server.value.trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS, or localhost for development.');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter just the server origin, such as https://watch.example.com.');
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) throw new Error('Server access is needed to create a room.');
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a website with a video first.');
    await chrome.storage.local.set({server: url.origin});
    await chrome.tabs.create({url: chrome.runtime.getURL(`host.html?tab=${tab.id}&server=${encodeURIComponent(url.origin)}`)});
    window.close();
  } catch (error) { status.textContent = error.message; start.disabled = false; }
});
