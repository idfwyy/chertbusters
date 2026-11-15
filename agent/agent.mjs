// Chertbusters on a Chert FaceTime line.
// Video the callers see: the game page (Chert's face, then the house, then Chert again).
// Audio: Chert's voice (ElevenLabs, OpenAI as backup). Brain: a ChatGPT model (brain.mjs) for anything that
// isn't a plain command. Chert sends one bridge participant: one mixed voice track and one FaceTime window
// capture. The window is split into caller tiles on this side, so each tile controls its own half.
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AutoSubscribe, defineAgent } from '@livekit/agents';
import { LocalAudioTrack, LocalVideoTrack, ParticipantKind, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { runAgent } from './chert-rooms.mjs';
import { greetWithFallback } from './greet.mjs';
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
const MOTION_LIMIT = +(process.env.FREEZE_MOTION || 9);
const RAN = ['picked', 'passed', 'failed'];

const AGREE = /\b(yes|yeah|yep|sure|okay|ok|we'?re in|i'?m in|let'?s (play|go)|play again|ready|we can help|sounds good)\b/;
const ASK = /\b(chert|where|what|how|why|can you|do you|hint|help|stuck|which)\b/;
const NAME_RE = [/\b(batman|bruce|batty|bat)\b/, /\b(spider[- ]?man|peter|spidey|spider)\b/];

const HELLO = 'Hello? Hello! It’s Chert!';
const GREETING = 'Mabel stole my spark stone! Can you help? Point to walk, fist to search, palm if she reaches for you. Say your hero’s name with voice commands.';
const TWO_PLAYERS = 'Two of you. Batman is on the left, Spider-Man on the right.';
const REPROMPT = 'Are you still there? I really need your help.';

const agent = defineAgent({
  prewarm: async () => { await prewarm([['chert', HELLO], ['chert', GREETING]]); },
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Start the page in parallel; audio and the greeting must not wait for Chromium.
    let game = null, closed = false;
    const gameReady = openGame({ dir: GAME_DIR, show: process.env.SHOW_GAME === '1', query: '&voicesync=1' })
      .then(async page => { if (closed) { await page.close(); return null; } game = page; return page; })
      .catch(error => { console.error('[game] could not open:', error.message); return null; });
    const stops = [];
    ctx.addShutdownCallback(async () => {
      closed = true;
      for (const stop of stops) { try { await stop(); } catch { /* call over */ } }
      if (game) await game.close();
    });
    let phase = 'lobby', players = 0, reprompt = null, lastHeard = 0, bridgeAt = 0;
    const recentSpeech = [];
    let speakingUntil = 0;
    const voice = new Voice({
      onStart: (id, ms) => { speakingUntil = Math.max(speakingUntil, Date.now() + (ms || 2000) + 700); if (id && game) void game.voiceStart(id, ms); },
      onDone: id => { speakingUntil = Date.now() + 900; if (id && game) void game.voiceDone(id); },
    });
    const audioTrack = LocalAudioTrack.createAudioTrack('chert-voice', voice.source);
    const video = new VideoSource(WIDTH, HEIGHT);
    const videoTrack = LocalVideoTrack.createVideoTrack('chertbusters', video);
    stops.push(() => voice.close(), () => videoTrack.close(), () => audioTrack.close());
    const audioReady = ctx.room.localParticipant.publishTrack(audioTrack, { source: TrackSource.SOURCE_MICROPHONE });
    // Do not wait for video publication before greeting.
    void audioReady.then(() => { if (!closed) return ctx.room.localParticipant.publishTrack(videoTrack, { source: TrackSource.SOURCE_CAMERA, simulcast: false, videoEncoding: { maxBitrate: BigInt(+(process.env.VIDEO_KBPS || 3500) * 1000), maxFramerate: FPS } }); })
      .catch(error => console.error('[chertbusters] track publication failed:', error.message));
    let sent = 0, sendErrors = 0;
    const sendFrame = () => { if (!game || closed) return; try { video.captureFrame(new VideoFrame(game.latestFrame(), WIDTH, HEIGHT, VideoBufferType.RGBA)); sent++; } catch (error) { if (sendErrors++ < 3) console.error('[chertbusters] video frame failed:', error.message); } };
    const timer = setInterval(sendFrame, 1000 / FPS);
    const stats = setInterval(() => { if (!game) return; const g = game.stats(); console.log(`[video] ${g.received} pictures from the game, ${g.decoded} decoded, ${sent} sent in the last 10 s${g.received === 0 ? '  <- the game page stopped drawing' : ''}`); g.reset(); sent = 0; }, 10_000);
    stops.push(() => clearInterval(timer), () => clearInterval(stats));
    const greeting = greetWithFallback(ctx.room, () => {
      if (!bridgeAt) bridgeAt = Date.now();
      recentSpeech.push(HELLO, GREETING);
      void audioReady.then(() => { if (!closed) { voice.say('chert', HELLO); voice.say('chert', GREETING); } })
        .catch(error => console.error('[chertbusters] greeting failed:', error.message));
      reprompt = setTimeout(() => { if (!closed && phase === 'lobby' && Date.now() - lastHeard > 22_000) { if (game) void game.say('chert', REPROMPT); else voice.say('chert', REPROMPT); } }, 28_000);
    }, () => { console.log('[chertbusters] bridge_ready'); if (!bridgeAt) bridgeAt = Date.now(); });
    stops.push(() => greeting.stop(), () => clearTimeout(reprompt));
    await ctx.waitForParticipant();
    console.log('[chertbusters] caller joined');
    if (!bridgeAt) bridgeAt = Date.now();
    greeting.callerJoined();
    if (!(await gameReady) || closed) return;
    void game.scriptLines().then(lines => prewarm([...lines, ['chert', REPROMPT], ['chert', TWO_PLAYERS]]));

    // ---- who is who ----
    let mixed = MIXED_ENV, tileCount = 0;
    const people = new Map();         // identity -> { stopAudio, stopVideo }
    const slots = [];                 // non-bridge calls: slots[0] = player 1
    const active = {};                // player -> current challenge { kind, since, base }
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
      const next = tiles.length;
      if (next !== tileCount) { tileCount = next; console.log(`[video] ${next} caller${next === 1 ? '' : 's'} in the FaceTime window`); }
      if (phase === 'playing' && next !== players) console.log(`[video] layout changed to ${next} tile(s); keeping the current player mapping`);
    }
    const slotForTile = (_tileId, index) => index;
    const playerForTile = (_tileId, index) => index;

    function startGame(asked = 1, sourceText = '') {
      if (phase === 'playing') return;
      if (sourceText && !AGREE.test(sourceText.toLowerCase())) { console.log(`[chertbusters] not starting: no agreement in "${sourceText}"`); return; }
      const n = Math.max(1, Math.min(2, FORCED_PLAYERS || tileCount || asked || 1));
      // Chert cuts calls at 5 minutes. Leave 15 s for the intro and the goodbyes.
      const left = 300_000 - (bridgeAt ? Date.now() - bridgeAt : 0) - 15_000;
      if (left < 45_000) { void game.say('chert', 'We’re nearly out of time on this call. Hang up and call me right back — I’ll be here.'); return; }
      clearTimeout(reprompt);
      players = n;
      phase = 'playing';
      for (const k of Object.keys(active)) delete active[k];
      brain.note(`Game started with ${players} player(s): ${NAMES.slice(0, players).join(' and ')}.`);
      console.log(`[chertbusters] starting with ${players} player${players > 1 ? 's' : ''} (${NAMES.slice(0, players).join(', ')}), ${Math.round(left / 1000)} s left on the call`);
      if (players === 2) void game.say('chert', TWO_PLAYERS);
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
        if (AGREE.test(t)) { startGame(playerCount(), text); return; }
        if (!brain.enabled) return;
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
        if (isBridge) { mixed = true; console.log('[chertbusters] one FaceTime bridge: all voices are mixed, so names pick the player'); }
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
      else if (event.type === 'gesture' && event.action === 'ready' && phase === 'lobby') { startGame(playerCount(), 'ready'); }
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
        phase = 'lobby';
        brain.note('The game page crashed and was reloaded.');
        await game.say('chert', 'Okay, I’m back. Tell me you’re in and we’ll go again.');
      } catch (error) { console.error('[chertbusters] reload failed', error.message); voice.say('chert', 'Sorry, the house won’t load. Call me back in a minute?'); }
    });

  },
});

export default agent;

runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'chertbusters' });
