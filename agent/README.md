# Chertbusters agent

Chert FaceTimes you, tells you Mabel stole his spark stone, "shares his screen", and you play a two-player horror game by voice and hand gestures. The callers see the game as Chert's camera. The agent sees the FaceTime window, splits the caller tiles, and uses each tile as that player's camera.

This folder is the whole runtime. The game page is `../game/index.html`.

## What you need

- A Mac that will run the agent. Node 22.12 or newer, or Node 24 or 26.
- A Chert line in a project where caller capture is enabled. Working audio does not prove caller video is enabled; confirm both directions on the assigned line.
- An iPhone to join the FaceTime call. For two players, a second phone or another person on the same call.
- An OpenAI key. ElevenLabs is optional; OpenAI is the backup voice.

## Setup

```sh
cd agent
npm install
npx playwright install chromium
cp .env.example .env.local
chmod 600 .env.local
nano .env.local
npm run preflight
```

Fill in `OPENAI_API_KEY` and `AGENT_NAME` at minimum. Fill the three `LIVEKIT_` values if you use your own LiveKit project; leave them empty on Chert's Shared plan. Add `ELEVENLABS_API_KEY`, `CHERT_VOICE_ID`, and `MABEL_VOICE_ID` for the good voices.

`npm run preflight` checks Node, the vendored Three.js and fonts, the MediaPipe models, Chromium, and the env file. It never prints a secret.

## Try it without a call

```sh
npm run preview
```

A window shows exactly what the callers would see. Type what a player says:

```
1 solo             start one player (use 1 ready for two)
1 hey chert what do we do?
1 ready
1 left
2 go check that cabinet
1 where's the key?
1 !motion          pretend Batman moved on camera
1 !light           pretend Batman turned on a light
```

With `&localcam` the Mac webcam becomes Batman's camera, so you can test hand gestures. The preview opens with `localcam=1`; add `&mirror` to the URL if you are testing a mirrored webcam.

## Real call

Terminal 1:

```sh
cd agent && npm start
```

Terminal 2:

```sh
cd agent
npx --yes @trychert/facetime@0.1.0-beta.20 login
npx --yes @trychert/facetime@0.1.0-beta.20 doctor
npx --yes @trychert/facetime@0.1.0-beta.20 dev --minutes 30
```

When `dev` says the agent is waiting, FaceTime **Video** the line from the iPhone. Add the second caller before or during the call. Wait for `FaceTime is ready`; Chert greets within ten seconds.

The left tile controls Batman and the right tile controls Spider-Man. No calibration is required. In a two-player game, say the hero's name before a voice command; questions without a name are answered generally.

Press Ctrl+C in terminal 2 when done, so the line is free for the next team.

## Controls

Voice works for everything. Gestures are a faster, showier alternative.

| Action | Voice | Hand |
| --- | --- | --- |
| Pick a door | "left", "right", "forward", "back", "upstairs", "downstairs" | point in that direction |
| Search | "search the desk", "check the wardrobe" | hold a fist |
| Strike the stone | "strike it" | fist during the strike challenge |
| Push Mabel back | "palm", "ward", "push" | hold an open palm during the ward challenge |
| Ready in the lobby | "okay", "sure", "we're in", "ready" | thumbs up |

The camera feed is not mirrored, so pointing to the right side of the picture is the player's left. The game highlights the option before it fires. Hold a gesture for about 450 ms; change the gesture or drop the hand before firing it again. Each caller tile controls that caller's half of the screen.

## What the agent sees

Chert sends one bridge participant: one mixed audio track and one `facetime-remote-video` track. The video is a capture of the FaceTime window, not a raw per-person camera. The agent finds the caller tiles by luma, drops the self-view and call buttons, and stabilises the layout over two frames.

Every few seconds it writes `caller-view-1.jpg` next to this README with the detected boxes drawn on it, plus `caller-view-1.json` with the coordinates. `TILE_DEBUG=1` also prints tile encode errors.

If the split is wrong:

- `TILE_COUNT=2` forces two equal columns when detection finds only one blob.
- `TILE_RECTS="x,y,w,h;x,y,w,h"` pins the crops in normalized coordinates. Copy `tileRects` from `caller-view-1.json` and add a little margin.
- `PLAYERS=2` forces two players even when only one tile is detected.

Caller capture can include the FaceTime controls, names, and self-preview depending on the line's capture profile. It is not always a raw camera feed. If the capture shows only one tile, or no caller video at all, the game still runs: voice controls and all non-camera challenges work, and camera challenges are skipped for the missing tile.

## If something goes wrong

- **No caller video**: confirm the call is FaceTime Video and caller capture is enabled on the assigned line. `chert dev` prints what the Mac is taking from the room. The agent logs `[video] camera from chert-bridge-...: 1280x720 rot 0` when frames arrive.
- **Only one tile**: the other caller is off camera or FaceTime is showing a single active-speaker layout. Set `TILE_COUNT=2` or pin `TILE_RECTS`; keep both callers in frame.
- **Hand gestures do nothing**: check the page console for `[camera] hand tracking unavailable`. Voice still works. On a slow Mac, raise `handhold` in the page URL or set `GAME_SOFTWARE_GL=1`.
- **Chert talks over people**: the agent ignores transcripts while its own voice is playing and for 900 ms after. If the echo persists, lower the phone volume or use headphones; the mixed audio track feeds Chert's voice back into the call.
- **The call ends at five minutes**: this is Chert's per-call cap on trial and Shared plans. The game timer leaves a 15-second margin and warns at 60, 30, and 10 seconds.
- **The game page crashes**: the agent reloads it and returns to the lobby. `npm run check` catches syntax errors before a call.

## Files

| File | Job |
| --- | --- |
| `agent.mjs` | LiveKit room, the one video/audio publisher, tile mapping, lobby, echo guard |
| `listen.mjs` | Speech-to-text, loudness, per-tile luma samples, tile crops, snapshots |
| `tiles.mjs` | Caller-tile detector and layout stabiliser (pure functions, unit tested) |
| `brain.mjs` | Chert's ChatGPT persona and tools |
| `voice.mjs` | ElevenLabs and OpenAI speech, cache, line cleanup |
| `game.mjs` | Hidden Chromium, local file server, page API, screencast frames |
| `preview.mjs` | Typed-input test harness with the real page |
| `../game/index.html` | The game |
| `../game/gestures.js` | Hand landmark classifier (pure functions, unit tested) |

## Checks

```sh
npm run check    # syntax of every agent file and the page module
npm test         # tile detector and gesture classifier
npm run preflight
```

## Security and cost

`.env.local` and `voice-cache/` are gitignored. Never commit them. Chert minutes come from the Chert plan; OpenAI and ElevenLabs usage is a few cents per game. Calls on the trial and Shared plans are capped at five minutes.
