# Content Watcher

A Chrome/Edge extension for host-controlled watch rooms. The host opens a video on a website, shares that tab, and sends a private link. Guests watch the tab's live picture and audio in a regular browser, without installing the extension. The host plays, pauses and seeks using the original website. Guests have local volume and fullscreen, with no timeline or playback controls and no remote-control channel.

## Run locally

Requires Node.js 22+ and Chrome/Edge 116+ for the host. No npm dependencies or build step.

1. Run `npm.cmd start` on Windows (`npm start` on other systems). The room server listens at `http://localhost:8787`.
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose **Load unpacked**, and select the `Content Watcher` folder in this repository.
3. Open a video website and click the extension. Leave the room server as `http://localhost:8787` for a same-computer test. Click **Start a watch room**, grant access to the server, then **Share video tab** in the host room.
4. Copy the invite link and open it in a second browser window. Click **Join watch room**, then **Enable sound**. Keep the host room tab open and use **Go to video tab** to control the original video.
5. Seek/pause/play in the source tab. The guest sees the resulting live stream. **End room for everyone**, closing the host room, or stopping browser capture disconnects guests and invalidates the invite.

The entire source tab is shared, including navigation and anything visible inside the tab. Fullscreen the website's video for a player-only picture. DRM-protected video, restricted browser pages, or sites that prevent capture may be blank or unavailable. This does not bypass content protection. Guests may mute or close their own player; they cannot change the host's playback.

## Share with someone on another computer

Deploy this Node server at a public **HTTPS** origin and enter that origin in the extension. Localhost links only work on the same computer. The server supplies the guest page and relays WebRTC setup messages over authenticated HTTP and streaming SSE; media travels over WebRTC. Use a reverse proxy that supports long-lived responses, disables SSE buffering, and has an idle timeout above 30 seconds. Bind port with `PORT` (default `8787`) and interface with `HOST` (default `0.0.0.0`).

For reliable connections across restrictive networks, configure a TURN service using the `ICE_SERVERS` environment variable (JSON array of standard WebRTC ICE server objects). For example, in PowerShell:

```powershell
$env:ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},{"urls":"turns:turn.example.com:5349","username":"your-user","credential":"your-password"}]'
npm.cmd start
```

Use your actual relay provider's values. Without TURN, direct connections can fail on some networks. ICE credentials are sent to room participants: use scoped, short-lived credentials for a public deployment. The default configuration uses Google's public STUN server and no TURN relay.

## Behavior and limits

- Invite links contain an unguessable guest capability in the URL fragment. Server requests use bearer authorization. The host capability is separate and never included in the invitation. Anyone with the full invite can join.
- The server accepts only WebRTC offers from the host, answers from guests, and ICE candidates. Guests cannot route messages to one another or end the room. There is no remote seek/play/pause API.
- Rooms exist in memory, expire after six hours, and end on host disconnect or server restart. A lost connection requires reopening/rejoining the invite; if the host disconnects, create a new room.
- Each room supports up to eight guests. The host uploads a separate stream to every guest, so available upload speed and CPU limit quality. This is a small-group implementation, not a large broadcast service.
- Viewers see the same host stream with normal network delay. This is not frame-exact synchronization across guests. Local guest volume does not affect anyone else.
- Basic limits cap rooms, guest reservations, request size and request rate. Before broad public deployment, add your authentication/access policy, managed TURN credentials, monitoring and deployment-specific abuse controls. IP rate limits use the direct socket address; consider this when placing the server behind a proxy.
- Tab audio is routed back to the host through an AudioContext, as required by [Chrome's tab capture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture). The muted host preview avoids echo. Guest audio needs an explicit click due to browser autoplay rules.

## Checks

Run `npm.cmd test` (or `npm test`). The integration suite exercises room creation, multiple guests, signaling, authorization, playback-command rejection, capacity, disconnect cleanup and guest asset delivery. Test capture and audio manually with the unpacked extension; these depend on browser permissions and the source website.

`npm.cmd run test:browser` runs an optional headless Edge smoke test using generated local video and audio. Set `BROWSER_PATH` to a Chromium browser executable if needed. It verifies real WebRTC media reception, guest count, absence of playback controls, audio toggle, local volume, mobile overflow and room shutdown; desktop/mobile screenshots go to the ignored `artifacts/` directory. This test substitutes a synthetic source for `tabCapture` and does not verify website capture permissions or DRM behavior.
