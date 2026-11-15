# Dead Line agent

Chert FaceTimes you, explains the mission, "shares his screen", and you play Dead Line by voice.

- Video the callers see: the game page in call mode (`game/index.html?view=call`): Chert full screen, then the house, then Chert again at the end.
- Brain: a ChatGPT model (`brain.mjs`) sees the whole game and decides what Chert says and does. Plain commands run instantly without it; everything else (questions, unclear speech, "where's the key?", "repeat that", someone dropping off, a crash) goes to the brain, which answers in character and can make moves for players.
- Voice: ElevenLabs for Chert and Mabel, with OpenAI's voice as backup, and a beep if both fail so the call never goes silent.
- Controls: each caller's own voice drives their own side of the split screen ("left", "upstairs", "search the desk", "hello", "strike it").
- Camera checks: freezing (Please hold) and turning on a light (Blackout) are read from each caller's camera. Laughing (don't laugh) is read from their audio.

## Setup (once)

```sh
cd ~/ghost-house/agent
npm install
npx playwright install chromium
cp .env.example .env.local && chmod 600 .env.local
```

Open `.env.local` with `nano .env.local` and fill in `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, the two voice IDs and `AGENT_NAME`.
On the free trial, also add the three `LIVEKIT_` values from a free LiveKit Cloud project. On Chert's Shared plan, leave them empty.

## Try it free, without Chert

```sh
npm run preview
```

A window shows exactly what the callers would see. Type what players would say: `1 hey chert what do we do?`, `1 ready`, `1 left`, `2 go check that cabinet`, `1 where's the key?`, `1 !motion`.
Chert's brain answers and his voice plays through your speakers.

## Real call

Terminal 1:
```sh
cd ~/ghost-house/agent && npm start
```
Terminal 2:
```sh
cd ~/ghost-house/agent
npx --yes @trychert/facetime@0.1.0-beta.20 login
npx --yes @trychert/facetime@0.1.0-beta.20 doctor
npx --yes @trychert/facetime@0.1.0-beta.20 dev
```
When `dev` says the agent is waiting, FaceTime **Video** the line from your iPhone (add your friend to the call). Say "ready".
Press Ctrl+C in terminal 2 when done, so the shared line is free for others.

## If Chert mixes everyone's voice

Set `MIXED_AUDIO=1` in `.env.local` and restart both terminals. Players then say their colour first: "orange, left", "blue, upstairs".
Terminal 1 prints `[dead-line] ... is Player 1` for each caller on the first call, which shows how Chert sends you the audio.

## Costs

Chert minutes come from your Chert plan. ChatGPT and speech to text cost a few cents per game. ElevenLabs uses character credits: a game is roughly 2,000 to 4,000 characters of speech.
