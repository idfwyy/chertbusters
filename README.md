# Chertbusters

A two-player horror game played over a real FaceTime call, built for the Chert "Best Use of FaceTime" track at HackUTA 2026.

Chert calls you. He is a nervous little stone whose spark was stolen by Mabel, a 1926 switchboard operator ghost. He shares his screen, which is the game: two floors, eighteen rooms, a brass key, a sealed red door, and a spark stone. The callers see the game as Chert's camera. The agent sees the FaceTime window, splits it into caller tiles, and reads each player's face and hands. Point at a door. Hold a fist to search. Hold a palm up when Mabel reaches for you. If she catches you, her face appears behind you in your own camera for a second.

## Why it is a FaceTime project

- The game is driven by what the agent sees: two caller tiles from one FaceTime window, per-player hand gestures, face attention, mouth movement, and a person mask that puts Mabel behind the right caller.
- The call itself is the controller. There is no app to install; one iPhone is enough for a solo demo, two for the full game.
- It uses the awkward part of the channel honestly: FaceTime sends one mixed audio track and a window capture, not one clean track per person. The agent splits the picture, calibrates which tile is which player, and attributes speech by name or lip movement.

## Run it

The runtime lives in `agent/`. See [`agent/README.md`](agent/README.md) for the full setup, the demo checklist, and troubleshooting.

```sh
cd agent
npm install
npx playwright install chromium
cp .env.example .env.local
chmod 600 .env.local
# fill in OPENAI_API_KEY and AGENT_NAME, plus voice keys if you have them
npm run preflight
npm run preview
```

For the real call, run `npm start` in one terminal and `chert dev --minutes 30` in another, then FaceTime Video the line.

## Controls

Voice works for everything: "left", "right", "forward", "back", "upstairs", "downstairs", "search the desk", "strike it", "palm", "ready". Hand gestures are the fast path: point to a door, hold a fist to search, hold an open palm to push Mabel back, thumbs up in the lobby to start.

## Notes

- Chert's trial and Shared plans cap a call at five minutes. The game timer ends before that and warns at 60, 30, and 10 seconds.
- Caller capture must be enabled on the assigned line. It may include FaceTime's controls, name pills, and self-view; the agent detects the caller tiles instead of assuming a fixed layout.
- The page, Three.js, fonts, and MediaPipe models are local, so the visual side does not depend on a CDN. The call itself uses LiveKit and Chert; the voice and brain use OpenAI and, if configured, ElevenLabs.
- `.env.local` is never committed.
