// Chertbusters on a Chert FaceTime line.
// Video the callers see: the game page (Chert's face, then the house, then Chert again).
// Audio: Chert's voice (ElevenLabs, OpenAI as backup). Brain: a ChatGPT model (brain.mjs) for anything that
// isn't a plain command. Chert sends one bridge participant: one mixed voice track and one FaceTime window
// capture. The window is split into caller tiles on this side, so each tile controls its own half.
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AutoSubscribe, defineAgent } from '@livekit/agents';
import { LocalAudioTrack, LocalVideoTrack, ParticipantKind, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { openGame, WIDTH, HEIGHT } from './game.mjs';
import { Voice, cleanLine, prewarm } from './voice.mjs';
import { listenAudio, watchVideo } from './listen.mjs';
import { Brain } from './brain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = process.env.GAME_DIR || join(HERE, '..', 'game');
const FPS = 15;
const NAMES = ['Batman', 'Spider-Man'];
const MIXED_ENV = process.env.MIXED_AUDIO === '1';
const FORCED_PLAYERS = Number(process.env.PLAYERS || 0) || 0;
const CALIBRATE = process.env.CALIBRATE !== '0';
const MOTION_LIMIT = +(process.env.FREEZE_MOTION || 9);
const RAN = ['picked', 'passed', 'failed'];

const AGREE = /\b(yes|yeah|yep|sure|okay|ok|we'?re in|i'?m in|let'?s (play|go)|play again|ready|we can help|sounds good)\b/;
const ASK = /\b(chert|where|what|how|why|can you|do you|hint|help|stuck|which)\b/;
const NAME_RE = [/\b(batman|bruce|batty|bat)\b/, /\b(spider[- ]?man|peter|spidey|spider)\b/];

const GREETING = 'Oh thank goodness, you picked up! It’s me, Chert. I’m in trouble — Mabel, the old switchboard ghost, stole my spark stone and sealed it upstairs in Hollow Line Manor. I can barely keep this line alive. Can you help me?';
const REPROMPT = 'Are you still there? I really need your help.';

const agent = defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Load the game while the room waits for a caller, so it is ready the moment someone calls.
    const game = await openGame({ dir: GAME_DIR, show: process.env.SHOW_GAME === '1', query: '&voicesync=1' });
    // Record the game's fixed lines ahead of time (only the first run does real work; they're saved in voice-cache/).
    void game.scriptLines().then(lines => prewarm([...lines, ['chert', GREETING], ['chert', REPROMPT]]));
    const stops = [];
    ctx.addShutdownCallback(async () => { for (const stop of stops) { try { await stop(); } catch { /* call over */ } } await game.close(); });
    await ctx.waitForParticipant();

    // One camera track (the game) and one audio track (Chert), both from this agent.
    const video = new VideoSource(WIDTH, HEIGHT);
    const videoTrack = LocalVideoTrack.createVideoTrack('chertbusters', video);
    let speakingUntil = 0;
    const voice = new Voice({
      onStart: (id, ms) => { speakingUntil = Math.max(speakingUntil, Date.now() + (ms || 2000) + 700); if (id) void game.voiceStart(id, ms); },
      onDone: id => { speakingUntil = Date.now() + 900; if (id) void game.voiceDone(id); },
    });
    const audioTrack = LocalAudioTrack.createAudioTrack('chert-voice', voice.source);
    // Higher bitrate and no simulcast, so the game's text stays sharp on FaceTime.
    await ctx.room.localParticipant.publishTrack(videoTrack, { source: TrackSource.SOURCE_CAMERA, simulcast: false, videoEncoding: { maxBitrate: BigInt(+(process.env.VIDEO_KBPS || 3500) * 1000), maxFramerate: FPS } });
    await ctx.room.localParticipant.publishTrack(audioTrack, { source: TrackSource.SOURCE_MICROPHONE });
    let sent = 0, sendErrors = 0;
    const sendFrame = () => { try { video.captureFrame(new VideoFrame(game.latestFrame(), WIDTH, HEIGHT, VideoBufferType.RGBA)); sent++; } catch (error) { if (sendErrors++ < 3) console.error('[chertbusters] video frame failed:', error.message); } };
    sendFrame();
    const timer = setInterval(sendFrame, 1000 / FPS);
    // Every 10 s: is the game still producing pictures? (Shows up in Terminal 1.)
    const stats = setInterval(() => { const g = game.stats(); console.log(`[video] ${g.received} pictures from the game, ${g.decoded} decoded, ${sent} sent in the last 10 s${g.received === 0 ? '  <- the game page stopped drawing' : ''}`); g.reset(); sent = 0; }, 10_000);
    stops.push(() => clearInterval(timer), () => clearInterval(stats), () => voice.close(), () => videoTrack.close(), () => audioTrack.close());

    // ---- who is who ----
    let phase = 'lobby', players = 0, reprompt = null, lastHeard = 0, bridgeAt = 0, bridgeReady = false;
    let mixed = MIXED_ENV, tileLayout = [], tileCount = 0, calibrated = false, calibrating = false, pendingStart = 0;
    const tileToPlayer = new Map();   // stable tile id -> player 0/1
    const playerToTile = new Map();   // player 0/1 -> stable tile id
    const people = new Map();         // identity -> { stopAudio, stopVideo }
    const slots = [];                 // non-bridge calls: slots[0] = player 1
    const active = {};                // player -> current challenge { kind, since, base }
    const recentSpeech = [];
    const isHuman = p => p.kind !== ParticipantKind.AGENT && p.identity !== ctx.room.localParticipant.identity;
    const slotOf = identity => {
      let s = slots.indexOf(identity);
      if (s < 0 && slots.length < 2) { slots.push(identity); s = slots.length - 1; console.log(`[chertbusters] ${identity} is ${NAMES[s]}`); }
      return s;
    };
    const voices = () => [...people.values()].filter(p => p.stopAudio).length;
    const playerCount = () => Math.max(1, Math.min(2, FORCED_PLAYERS || tileCount || voices() || 1));
    const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const similar = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      if (a.length > 12 && b.includes(a)) return true;
      if (b.length > 12 && a.includes(b)) return true;
      const aw = new Set(a.split(' ')), bw = new Set(b.split(' '));
      let same = 0;
      for (const w of aw) if (bw.has(w)) same++;
      return same / Math.max(1, Math.min(aw.size, bw.size)) > 0.8;
    };
    const isEcho = text => {
      if (Date.now() < speakingUntil) return true;
      const n = normalize(text);
      return !n || recentSpeech.some(line => similar(n, normalize(line)));
    };

    // ---- per-tile video ----
    function saveSnapshot(jpg, meta) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rects = (meta.tiles || []).map(b => ({ x: +(b.x / meta.width).toFixed(4), y: +(b.y / meta.height).toFixed(4), w: +(b.w / meta.width).toFixed(4), h: +(b.h / meta.height).toFixed(4) }));
      void writeFile(join(HERE, 'caller-view-1.jpg'), jpg).catch(() => {});
      void writeFile(join(HERE, 'caller-view-1.json'), JSON.stringify({ at: stamp, ...meta, rects, tileRects: rects.map(r => `${r.x},${r.y},${r.w},${r.h}`).join(';') }, null, 2)).catch(() => {});
    }
    function onTiles(tiles) {
      tileLayout = tiles;
      const next = tiles.length;
      if (next !== tileCount) { tileCount = next; console.log(`[video] ${next} caller${next === 1 ? '' : 's'} in the FaceTime window`); }
      if (!calibrated && !calibrating && bridgeReady && phase === 'lobby') void calibrate();
      if (phase === 'playing' && next !== players) console.log(`[video] layout changed to ${next} tile(s); keeping the current player mapping`);
    }
    const slotForTile = (tileId, index) => calibrated ? (tileToPlayer.get(tileId) ?? index) : index;
    const playerForTile = (tileId, index) => calibrated ? (tileToPlayer.get(tileId) ?? index) : index;

    async function askRaise(name, exclude = -1) {
      void game.say('chert', `${name}, hold your hand up next to your face so I can see you.`);
      await sleep(1200);
      let deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        const states = await game.handState().catch(() => []);
        const found = (states || []).filter(s => s.player !== exclude && s.hand?.raised && (s.hand.age == null || s.hand.age < 1500));
        if (found.length) return found.sort((a, b) => (b.hand.confidence || 0) - (a.hand.confidence || 0))[0].player;
        await sleep(250);
      }
      // A raised hand is the fun path. If Hands is unavailable, watch which mouth moves.
      void game.say('chert', `${name}, say “here” so I can hear you.`);
      await sleep(600);
      deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const states = await game.faceState().catch(() => []);
        const found = (states || []).filter(s => s.player !== exclude && (s.mouth || 0) > 0.015);
        if (found.length) return found.sort((a, b) => (b.mouth || 0) - (a.mouth || 0))[0].player;
        await sleep(250);
      }
      return -1;
    }

    async function calibrate() {
      if (calibrating || calibrated || phase !== 'lobby') return;
      calibrating = true;
      try {
        if (tileCount < 2) {
          calibrated = true;
          if (tileCount === 1) void game.say('chert', `I can see you, ${NAMES[0]}.`);
          return;
        }
        const firstSlot = await askRaise(NAMES[0]);
        const first = firstSlot >= 0 ? firstSlot : 0;
        const secondSlot = await askRaise(NAMES[1], first);
        const second = secondSlot >= 0 ? secondSlot : 1 - first;
        if (first === second) { console.log('[video] calibration saw the same tile twice; using left and right'); }
        const a = first === second ? 0 : first;
        const b = first === second ? 1 : second;
        tileToPlayer.clear(); playerToTile.clear();
        const tileA = tileLayout[a]?.id ?? a;
        const tileB = tileLayout[b]?.id ?? b;
        tileToPlayer.set(tileA, 0); tileToPlayer.set(tileB, 1);
        playerToTile.set(0, tileA); playerToTile.set(1, tileB);
        calibrated = true;
        console.log(`[video] ${NAMES[0]} = tile ${a}, ${NAMES[1]} = tile ${b}`);
        void game.say('chert', 'Got you both. Okay — listen closely.');
      } finally {
        calibrating = false;
        calibrated = true;
        if (pendingStart) { const n = pendingStart; pendingStart = 0; startGame(n, 'ready'); }
      }
    }

    function startGame(asked = 1, sourceText = '') {
      if (phase === 'playing') return;
      if (sourceText && !AGREE.test(sourceText.toLowerCase())) { console.log(`[chertbusters] not starting: no agreement in "${sourceText}"`); return; }
      const n = Math.max(1, Math.min(2, FORCED_PLAYERS || tileCount || asked || 1));
      if (!calibrated && CALIBRATE && tileCount >= 2) { pendingStart = n; void calibrate(); return; }
      if (calibrating) { pendingStart = n; return; }
      // Chert cuts calls at 5 minutes. Leave 15 s for the intro and the goodbyes.
      const left = 300_000 - (bridgeAt ? Date.now() - bridgeAt : 0) - 15_000;
      if (left < 45_000) { void game.say('chert', 'We’re nearly out of time on this call. Hang up and call me right back — I’ll be here.'); return; }
      clearTimeout(reprompt);
      players = n;
      phase = 'playing';
      for (const k of Object.keys(active)) delete active[k];
      brain.note(`Game started with ${players} player(s): ${NAMES.slice(0, players).join(' and ')}.`);
      console.log(`[chertbusters] starting with ${players} player${players > 1 ? 's' : ''} (${NAMES.slice(0, players).join(', ')}), ${Math.round(left / 1000)} s left on the call`);
      void game.start(players, { timeLeftMs: left });
    }

    const brain = new Brain({ game, startGame, playersNow: () => players || playerCount(), phase: () => phase, names: NAMES, tiles: () => tileCount });

    async function attribute(text) {
      for (const [i, re] of NAME_RE.entries()) if (re.test(text.toLowerCase())) return i;
      if (players === 1) return 0;
      return -1;
    }

    async function onText(identity, raw) {
      const text = cleanLine(raw);
      if (!text) return;
      const t = text.toLowerCase();
      if (isEcho(text)) { console.log(`[heard] ${identity}: (ignored echo) ${text}`); return; }
      lastHeard = Date.now();
      const player = mixed ? await attribute(text) : slotOf(identity);
      if (phase !== 'playing') {
        // The brain runs the lobby. Without a brain key, an agreement still starts the game.
        if (!brain.enabled) { if (AGREE.test(t)) startGame(playerCount(), text); return; }
        void brain.hear(player, text, 'lobby');
        return;
      }
      // A direct "where is the key/stone?" gets a deterministic hint from the page, so the
      // close/far → room → furniture progression is guaranteed rather than left to the model.
      if (player >= 0 && /\b(where|hint|stuck|help me find)\b/.test(t) && /\b(key|stone|door|room)\b/.test(t)) {
        const item = /\b(stone|door)\b/.test(t) ? 'stone' : 'key';
        const h = await game.hint(player, item);
        if (h?.text) { void game.say('chert', h.text); brain.note(`Hint for ${NAMES[player]}: ${h.text}`); return; }
      }
      // Questions and Chert's name go to the brain before the command parser. "Batman, left" still runs instantly.
      if (ASK.test(t)) { void brain.hear(player, text, 'question'); return; }
      let result = 'no player';
      if (player >= 0 && player < players) {
        void game.heard(player, text);
        result = await game.command(player, t.replace(NAME_RE[player], '').trim());
        if (RAN.includes(result)) { brain.note(`${NAMES[player]} said "${text}" -> ${result}`); return; }
      } else if (players > 1) {
        void game.prompt('Say BATMAN or SPIDER-MAN first');
        return;
      }
      // Not a plain command: let Chert's brain work out what they meant, or answer them.
      void brain.hear(player, text, result);
    }

    function playerFor(identity) {
      if (!mixed) return slots.indexOf(identity);
      const live = Object.keys(active).map(Number);
      return live.length === 1 ? live[0] : -1;
    }
    function onLoud(identity) {
      const p = playerFor(identity), ch = active[p];
      if (ch && ch.kind === 'smile' && Date.now() - ch.since > 600) void game.signal(p, 'smile');
    }
    function onSample(player, s) {
      const ch = active[player];
      if (!ch) return;
      if (Date.now() - ch.since < 700) { ch.base = ch.base == null ? s.brightness : Math.min(ch.base, s.brightness); return; }
      if (ch.kind === 'freeze' && s.motion > MOTION_LIMIT) void game.signal(player, 'motion');
      if (ch.kind === 'light' && ch.base != null && s.brightness > ch.base * 1.35 && s.brightness - ch.base > 18) void game.signal(player, 'light');
    }

    // ---- hearing and seeing each caller ----
    function attach(track, participant) {
      if (!isHuman(participant)) return;
      const id = participant.identity;
      const isBridge = /^chert-bridge-/.test(id);
      const person = people.get(id) || {};
      people.set(id, person);
      console.log(`[chertbusters] ${id} sent a ${track.kind === TrackKind.KIND_AUDIO ? 'voice' : 'camera'} track`);
      if (track.kind === TrackKind.KIND_AUDIO && !person.stopAudio) {
        if (isBridge) { mixed = true; console.log('[chertbusters] one FaceTime bridge: all voices are mixed, so names or lip motion pick the player'); }
        person.stopAudio = listenAudio(track, { label: id, onText: text => void onText(id, text), onLoud: () => onLoud(id) });
        if (!mixed) slotOf(id);
      }
      if (track.kind === TrackKind.KIND_VIDEO && !person.stopVideo) {
        if (isBridge) {
          person.stopVideo = watchVideo(track, {
            label: id,
            onTiles,
            onTile: (tileId, jpg, index) => { const p = slotForTile(tileId, index); if (p >= 0) void game.cam(p, jpg); },
            onSample: (tileId, s, index) => onSample(playerForTile(tileId, index), s),
            onSnapshot: saveSnapshot,
          });
        } else {
          const p = slotOf(id);
          if (p >= 0) person.stopVideo = watchVideo(track, {
            label: id,
            onFrame: jpg => void game.cam(p, jpg),
            onSample: s => onSample(p, s),
            onSnapshot: saveSnapshot,
          });
        }
      }
    }
    for (const participant of ctx.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track, participant);
    ctx.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => attach(track, participant));
    ctx.room.on(RoomEvent.ParticipantDisconnected, participant => {
      const person = people.get(participant.identity);
      person?.stopAudio?.(); person?.stopVideo?.();
      people.delete(participant.identity);
      const s = slots.indexOf(participant.identity);
      if (s >= 0 && phase === 'playing' && people.size > 0) void brain.situation(`${NAMES[s]} just dropped off the FaceTime call. The others are still here.`);
    });
    stops.push(() => { for (const person of people.values()) { person.stopAudio?.(); person.stopVideo?.(); } });

    // ---- the game talks, Chert speaks; the brain keeps track ----
    game.events.on('event', event => {
      if (event.type === 'say') {
        const text = cleanLine(event.text);
        if (!text) return;
        recentSpeech.push(text); if (recentSpeech.length > 6) recentSpeech.shift();
        speakingUntil = Math.max(speakingUntil, Date.now() + Math.max(1600, text.length * 70) + 800);
        voice.say(event.who, text, { id: event.id, urgent: event.urgent });
        brain.heardChert(event.who, text);
      }
      else if (event.type === 'challenge_start') { active[event.player] = { kind: event.challenge, since: Date.now(), base: null }; brain.note(`${NAMES[event.player] || 'P' + (event.player + 1)} challenge: ${event.challenge}`); }
      else if (event.type === 'challenge_end') { delete active[event.player]; brain.note(`${NAMES[event.player] || 'P' + (event.player + 1)} ${event.passed ? 'passed' : 'failed'} ${event.challenge}`); }
      else if (event.type === 'gesture' && event.action === 'ready' && phase === 'lobby' && !calibrating) { startGame(playerCount(), 'ready'); }
      else if (event.type === 'scream') { voice.say('mabel', 'Aah!', { urgent:true }); brain.note(`Mabel caught ${NAMES[event.player] || 'a player'}.`); }
      else if (event.type === 'entered') brain.note(`${NAMES[event.player] || 'P' + (event.player + 1)} entered the ${event.room}`);
      else if (event.type === 'search') brain.note(`${NAMES[event.player] || 'P' + (event.player + 1)} searched the ${event.spot}: ${event.found || 'nothing'}`);
      else if (event.type === 'clue') brain.note(`${NAMES[event.player] || 'P' + (event.player + 1)} got a clue: ${event.text}`);
      else if (['encounter', 'caught', 'sealed_room_found', 'unsealed', 'scare', 'win', 'glimpse'].includes(event.type)) brain.note(`${event.type}${event.player != null ? ` (${NAMES[event.player] || 'P' + (event.player + 1)})` : ''}`);
      else if (event.type === 'game_over') { phase = 'over'; brain.note(`Game over. Winner: ${event.winner == null ? 'nobody' : NAMES[event.winner]}. Stone was in the ${event.stone}.`); console.log('[chertbusters] game over', JSON.stringify(event)); }
    });

    // ---- if the game page crashes, Chert covers for it and reloads ----
    game.events.on('crash', async () => {
      voice.say('chert', 'Whoa, the house just glitched. Give me two seconds.');
      try {
        await game.reload();
        phase = 'lobby'; calibrated = false; calibrating = false; tileToPlayer.clear(); playerToTile.clear();
        brain.note('The game page crashed and was reloaded.');
        await game.say('chert', 'Okay, I’m back. Tell me you’re in and we’ll go again.');
        if (tileCount >= 2) void calibrate();
      } catch (error) { console.error('[chertbusters] reload failed', error.message); voice.say('chert', 'Sorry, the house won’t load. Call me back in a minute?'); }
    });

    // ---- greet when FaceTime is ready (Chert ends calls that stay silent for 10 seconds) ----
    const stopGreeting = greetOnBridgeReady(ctx.room, () => {
      bridgeAt = Date.now(); bridgeReady = true;
      void game.sayWait('chert', GREETING).then(() => { if (CALIBRATE) void calibrate(); });
      reprompt = setTimeout(() => { if (phase === 'lobby' && Date.now() - lastHeard > 22_000) void game.say('chert', REPROMPT); }, 28_000);
    });
    stops.push(() => stopGreeting(), () => clearTimeout(reprompt));
  },
});

export default agent;

runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'chertbusters' });
