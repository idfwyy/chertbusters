// Dead Line on a Chert FaceTime line.
// Video the callers see: the game page (Chert's face, then the house, then Chert again).
// Audio: Chert's voice (ElevenLabs, OpenAI as backup). Brain: a ChatGPT model (brain.mjs) for anything that
// isn't a plain command. Each caller's own audio controls their own side of the split screen.
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AutoSubscribe, defineAgent } from '@livekit/agents';
import { LocalAudioTrack, LocalVideoTrack, ParticipantKind, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { openGame, WIDTH, HEIGHT } from './game.mjs';
import { Voice, prewarm } from './voice.mjs';
import { listenAudio, watchVideo } from './listen.mjs';
import { Brain } from './brain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = process.env.GAME_DIR || join(HERE, '..', 'game');
const FPS = 15;
// Separate voices (default): each caller is their own participant, so plain "left" goes to that caller's screen.
// If Chert mixes everyone into one audio track, set MIXED_AUDIO=1: players say their colour first ("orange, left").
const MIXED = process.env.MIXED_AUDIO === '1';
const COLOUR = [/\b(orange|player one)\b/, /\b(blue|player two)\b/];
const MOTION_LIMIT = +(process.env.FREEZE_MOTION || 9);
const RAN = ['picked', 'passed', 'failed'];   // what game.command returns when it understood the words

const GREETING = MIXED
  ? 'Oh thank goodness, you picked up! It’s me, Chert. Orange is player one, blue is player two. Start every move with your colour. Say ready when you’re both here.'
  : 'Oh thank goodness, you picked up! It’s me, Chert. I really need your help. Say ready when everyone’s here.';

const agent = defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Load the game while the room waits for a caller, so it is ready the moment someone calls.
    const game = await openGame({ dir: GAME_DIR, show: process.env.SHOW_GAME === '1', query: '&voicesync=1' });
    // Record the game's fixed lines ahead of time (only the first run does real work; they're saved in voice-cache/).
    void game.scriptLines().then(lines => prewarm([...lines, ['chert', GREETING], ['chert', 'Whenever you’re set, just say ready.']]));
    const stops = [];
    ctx.addShutdownCallback(async () => { for (const stop of stops) { try { await stop(); } catch { /* call over */ } } await game.close(); });
    await ctx.waitForParticipant();

    // One camera track (the game) and one audio track (Chert), both from this agent.
    const video = new VideoSource(WIDTH, HEIGHT);
    const videoTrack = LocalVideoTrack.createVideoTrack('dead-line', video);
    const voice = new Voice({ onStart: (id, ms) => { if (id) void game.voiceStart(id, ms); }, onDone: id => { if (id) void game.voiceDone(id); } });
    const audioTrack = LocalAudioTrack.createAudioTrack('chert-voice', voice.source);
    // Higher bitrate and no simulcast, so the game's text stays sharp on FaceTime.
    await ctx.room.localParticipant.publishTrack(videoTrack, { source: TrackSource.SOURCE_CAMERA, simulcast: false, videoEncoding: { maxBitrate: BigInt(+(process.env.VIDEO_KBPS || 3500) * 1000), maxFramerate: FPS } });
    await ctx.room.localParticipant.publishTrack(audioTrack, { source: TrackSource.SOURCE_MICROPHONE });
    let sent = 0, sendErrors = 0;
    const sendFrame = () => { try { video.captureFrame(new VideoFrame(game.latestFrame(), WIDTH, HEIGHT, VideoBufferType.RGBA)); sent++; } catch (error) { if (sendErrors++ < 3) console.error('[dead-line] video frame failed:', error.message); } };
    sendFrame();
    const timer = setInterval(sendFrame, 1000 / FPS);
    // Every 10 s: is the game still producing pictures? (Shows up in Terminal 1.)
    const stats = setInterval(() => { const g = game.stats(); console.log(`[video] ${g.received} pictures from the game, ${g.decoded} decoded, ${sent} sent in the last 10 s${g.received === 0 ? '  <- the game page stopped drawing' : ''}`); g.reset(); sent = 0; }, 10_000);
    stops.push(() => clearInterval(timer), () => clearInterval(stats), () => voice.close(), () => videoTrack.close(), () => audioTrack.close());

    // ---- who is who ----
    let phase = 'lobby', players = 0, reprompt = null, lastHeard = 0, bridgeAt = Date.now();
    const people = new Map();      // identity -> { stopAudio, stopVideo }
    const slots = [];              // slots[0] = Player 1 (orange), slots[1] = Player 2 (blue)
    const active = {};             // player -> current challenge { kind, since, base }
    const isHuman = p => p.kind !== ParticipantKind.AGENT && p.identity !== ctx.room.localParticipant.identity;
    const slotOf = identity => {
      let s = slots.indexOf(identity);
      if (s < 0 && slots.length < 2) { slots.push(identity); s = slots.length - 1; console.log(`[dead-line] ${identity} is Player ${s + 1} (${s ? 'blue' : 'orange'})`); }
      return s;
    };
    const voices = () => [...people.values()].filter(p => p.stopAudio).length;

    function startGame(asked = 1) {
      if (phase === 'playing') return;
      clearTimeout(reprompt);
      players = MIXED ? Math.max(1, Math.min(2, asked || 2)) : Math.max(1, Math.min(2, voices()));
      phase = 'playing';
      for (const k of Object.keys(active)) delete active[k];
      brain.note(`Game started with ${players} player(s).`);
      console.log(`[dead-line] starting with ${players} player${players > 1 ? 's' : ''} (${MIXED ? 'colour commands' : 'separate voices'})`);
      // Chert cuts calls at 5 minutes: the game's countdown ends a little before that.
      void game.start(players, { timeLeftMs: Math.max(90_000, 300_000 - (Date.now() - bridgeAt) - 12_000) });
    }

    const brain = new Brain({ game, startGame, playersNow: () => (MIXED ? 2 : voices()), phase: () => phase });

    async function onText(identity, text) {
      const t = text.toLowerCase();
      console.log(`[heard] ${identity}: ${text}`);
      lastHeard = Date.now();
      let player = MIXED ? (COLOUR[0].test(t) ? 0 : COLOUR[1].test(t) ? 1 : players === 1 ? 0 : -1) : slotOf(identity);
      if (phase !== 'playing') {
        // The brain runs the lobby. Without a brain key, "ready" still starts the game.
        if (!brain.enabled) { if (/\b(ready|start|let'?s go|play again|again)\b/.test(t)) startGame(MIXED && /\b(solo|one player|just me)\b/.test(t) ? 1 : 2); return; }
        void brain.hear(player, text, 'lobby');
        return;
      }
      let result = 'no player';
      if (player >= 0 && player < players) {
        void game.heard(player, text);
        result = await game.command(player, t);
        if (RAN.includes(result)) { brain.note(`P${player + 1} said "${text}" -> ${result}`); return; }
      }
      // Not a plain command: let Chert's brain work out what they meant, or answer them.
      void brain.hear(player, text, result);
    }

    function playerFor(identity) {
      if (!MIXED) return slots.indexOf(identity);
      const live = Object.keys(active).map(Number);
      return live.length === 1 ? live[0] : -1;
    }
    function onLoud(identity) {
      const p = playerFor(identity), ch = active[p];
      if (ch && ch.kind === 'smile' && Date.now() - ch.since > 600) void game.signal(p, 'smile');
    }
    function onSample(identity, s) {
      const p = playerFor(identity), ch = active[p];
      if (!ch) return;
      if (Date.now() - ch.since < 700) { ch.base = ch.base == null ? s.brightness : Math.min(ch.base, s.brightness); return; }
      if (ch.kind === 'freeze' && s.motion > MOTION_LIMIT) void game.signal(p, 'motion');
      if (ch.kind === 'light' && ch.base != null && s.brightness > ch.base * 1.35 && s.brightness - ch.base > 18) void game.signal(p, 'light');
    }

    // ---- hearing and seeing each caller ----
    function attach(track, participant) {
      if (!isHuman(participant)) return;
      const id = participant.identity;
      const person = people.get(id) || {};
      people.set(id, person);
      console.log(`[dead-line] ${id} sent a ${track.kind === TrackKind.KIND_AUDIO ? 'voice' : 'camera'} track`);
      if (track.kind === TrackKind.KIND_AUDIO && !person.stopAudio) {
        person.stopAudio = listenAudio(track, { label: id, onText: text => void onText(id, text), onLoud: () => onLoud(id) });
        if (!MIXED) slotOf(id);
      }
      if (track.kind === TrackKind.KIND_VIDEO && !person.stopVideo) person.stopVideo = watchVideo(track, { label: id, onSample: s => onSample(id, s), onSnapshot: jpg => void writeFile(join(HERE, `caller-view-${people.size > 1 ? [...people.keys()].indexOf(id) + 1 : 1}.jpg`), jpg).catch(() => {}), onFrame: jpg => { const p = MIXED ? 0 : slots.indexOf(id); if (p >= 0) void game.cam(p, jpg); } });
    }
    for (const participant of ctx.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track, participant);
    ctx.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => attach(track, participant));
    ctx.room.on(RoomEvent.ParticipantDisconnected, participant => {
      const person = people.get(participant.identity);
      person?.stopAudio?.(); person?.stopVideo?.();
      people.delete(participant.identity);
      const s = slots.indexOf(participant.identity);
      if (s >= 0 && phase === 'playing' && people.size > 0) void brain.situation(`Player ${s + 1} (${s ? 'blue' : 'orange'}) just dropped off the FaceTime call. The others are still here.`);
    });
    stops.push(() => { for (const person of people.values()) { person.stopAudio?.(); person.stopVideo?.(); } });

    // ---- the game talks, Chert speaks; the brain keeps track ----
    game.events.on('event', event => {
      if (event.type === 'say') { voice.say(event.who, event.text, { id: event.id, urgent: event.urgent }); brain.heardChert(event.who, event.text); }
      else if (event.type === 'challenge_start') { active[event.player] = { kind: event.challenge, since: Date.now(), base: null }; brain.note(`P${event.player + 1} challenge: ${event.challenge}`); }
      else if (event.type === 'challenge_end') { delete active[event.player]; brain.note(`P${event.player + 1} ${event.passed ? 'passed' : 'failed'} ${event.challenge}`); }
      else if (event.type === 'entered') brain.note(`P${event.player + 1} entered the ${event.room}`);
      else if (event.type === 'search') brain.note(`P${event.player + 1} searched the ${event.spot}: ${event.found || 'nothing'}`);
      else if (event.type === 'clue') brain.note(`P${event.player + 1} got a clue: ${event.text}`);
      else if (['encounter', 'caught', 'sealed_room_found', 'unsealed', 'scare', 'win'].includes(event.type)) brain.note(`${event.type}${event.player != null ? ` (P${event.player + 1})` : ''}`);
      else if (event.type === 'game_over') { phase = 'over'; brain.note(`Game over. Winner: ${event.winner == null ? 'nobody' : 'P' + (event.winner + 1)}. Stone was in the ${event.stone}.`); console.log('[dead-line] game over', JSON.stringify(event)); }
    });

    // ---- if the game page crashes, Chert covers for it and reloads ----
    game.events.on('crash', async () => {
      voice.say('chert', 'Whoa, the house just glitched. Give me two seconds.');
      try { await game.reload(); phase = 'lobby'; brain.note('The game page crashed and was reloaded.'); await game.say('chert', 'Okay, I’m back. Say ready and we’ll start again.'); }
      catch (error) { console.error('[dead-line] reload failed', error.message); voice.say('chert', 'Sorry, the house won’t load. Call me back in a minute?'); }
    });

    // ---- greet when FaceTime is ready (Chert ends calls that stay silent for 10 seconds) ----
    const stopGreeting = greetOnBridgeReady(ctx.room, () => {
      bridgeAt = Date.now();
      void game.say('chert', GREETING);
      reprompt = setTimeout(() => { if (phase === 'lobby' && Date.now() - lastHeard > 20_000) void game.say('chert', 'Whenever you’re set, just say ready.'); }, 25_000);
    });
    stops.push(() => stopGreeting(), () => clearTimeout(reprompt));
  },
});

export default agent;

runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'dead-line' });
