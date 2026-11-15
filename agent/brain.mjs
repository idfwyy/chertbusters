// Chert's brain: a ChatGPT model that sees the game and decides what Chert says and does.
//
// Clear commands ("left", "search the desk") never wait for the brain: the game runs them at once.
// Everything else comes here: questions, unclear speech, "where do I go?", "repeat that", "I can't hear you",
// someone leaving the call, a crash. The brain answers in Chert's voice and can act through three tools.
import { cleanLine } from './voice.mjs';

const MODELS = () => [...new Set([process.env.BRAIN_MODEL || 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini'])];

const PERSONA = `You are Chert, a small, friendly orange stone with a telephone headset. You host Chertbusters, a horror game on a group FaceTime call.
Story: Mabel, the ghost of a 1926 switchboard operator, stole your spark stone and sealed it in a room upstairs in Hollow Line Manor. Without it you can't connect calls and your signal is dying. The players search the house for Mabel's brass key, find the red glowing door upstairs, unlock it, and strike your stone. The first to strike it wins.
Players: the left side is Batman, the right side is Spider-Man. Never call them orange or blue. If there is one player, it is Batman.
How the game works: each player can independently move through a door, use stairs, or search at any time. If Mabel finds a player she gives a challenge: freeze ("please hold"), turn on a real light ("blackout"), don't laugh, hold your palm up to push her back, show something metal for a padlock, or strike the stone. Failing can disconnect that player.

How you talk: you are on a live call. One or two short sentences, under 30 words. Warm, quick, a little nervous, funny. Never read out lists of rules or options; the screen shows them. Never mention tools, JSON, the game state, or being an AI model unless asked directly. Never write "Chert:" or "Mabel:" at the start of a line.

How you act:
- When a player clearly wants a move, call choose_option with one of THAT player's listed option keys. Map loose speech to the closest option. If ambiguous, stay silent; never ask who or which.
- Never list options or ask "what next?". The screen shows the choices.
- During the game, reply only when someone talks to Chert directly or asks a question. Return an empty reply for chatter and plain move commands.
- Hints: use the hint data in the game state. First give a direction and whether the key or stone is close or far. If they ask again or have been stuck for about a minute, name the room. Only then name the furniture. Never reveal the exact room on the first ask.
- Only call challenge_action when the player is in that challenge and their words say they did it (e.g. "my light is on", "strike!", "I've got keys", "palm up").
- In the lobby (before the game): be a real host. Open like a friend in trouble. Answer any number of questions and interruptions about Mabel, the stone, the house, or what to do. Then ask "will you help me?" Call start_game as soon as anyone agrees ("okay", "sure", "we're in", "let's play", "ready"). Say "ready" at most once, and never repeat a sentence you just said (see youJustSaid).
- If someone says they can't hear or see, can't understand, or asks you to repeat, repeat the important part simply.
- If the speech is chatter not meant for you, or you have nothing useful to add, reply with an empty message and no tools.`;

const TOOLS = [
  { type: 'function', function: { name: 'choose_option', description: 'Pick a move for a player this round.', parameters: { type: 'object', properties: { player: { type: 'integer', enum: [1, 2] }, option: { type: 'string', description: 'One of that player\'s option keys, exactly as listed' } }, required: ['player', 'option'], additionalProperties: false } } },
  { type: 'function', function: { name: 'challenge_action', description: 'The player did what their current challenge asks.', parameters: { type: 'object', properties: { player: { type: 'integer', enum: [1, 2] }, action: { type: 'string', enum: ['strike', 'light', 'metal', 'palm'] } }, required: ['player', 'action'], additionalProperties: false } } },
  { type: 'function', function: { name: 'start_game', description: 'Start the game when players agree to help.', parameters: { type: 'object', properties: { players: { type: 'integer', enum: [1, 2] } }, required: ['players'], additionalProperties: false } } },
];

export class Brain {
  /** @param {{ game: any, startGame: (players:number, sourceText?:string) => void, playersNow: () => number, phase: () => string, names?: string[], tiles?: () => number }} deps */
  constructor(deps) {
    this.deps = deps;
    this.names = deps.names || ['Batman', 'Spider-Man'];
    this.history = [];      // recent user/assistant turns
    this.events = [];       // recent game events, as short lines
    this.spoken = [];       // what Chert and Mabel said recently
    this.queue = Promise.resolve();
    this.model = null;
    this.lastText = '';
    this.enabled = Boolean(process.env.OPENAI_API_KEY);
    if (!this.enabled) console.error('[brain] OPENAI_API_KEY is missing: Chert will only follow plain commands.');
  }

  /** Remember a game event so the brain knows what just happened. */
  note(line) { this.events.push(line); if (this.events.length > 18) this.events.shift(); }
  heardChert(who, text) { this.spoken.push(`${who === 'mabel' ? 'Mabel' : 'Chert'}: ${text}`); if (this.spoken.length > 6) this.spoken.shift(); }

  /** A player said something the game could not run directly. player is 0/1, or -1 if unknown. */
  hear(player, text, why = '') {
    this.lastText = text;
    const at = Date.now();
    this.queue = this.queue.then(() => (Date.now() - at > 9000 ? null : this.#think(player, text, why))).catch(error => console.error('[brain]', error.message));
    return this.queue;
  }

  /** Something went wrong outside the players' speech (crash, someone left). Let Chert handle it out loud. */
  situation(text) { return this.hear(-1, `[situation, not a player] ${text}`); }

  async #think(player, text, why) {
    if (!this.enabled) return;
    const { game } = this.deps;
    const [state, secrets] = await Promise.all([game.state().catch(() => null), game.secrets().catch(() => null)]);
    const who = player >= 0 ? `${this.names[player] || `Player ${player + 1}`}` : 'Someone on the call';
    const view = {
      phase: this.deps.phase(),
      round: state?.round, chertSignalBars: state?.signal, keyFound: state?.keyFound, redDoorFound: state?.sealedRoomFound,
      players: (state?.players || []).map(p => ({
        player: p.player + 1,
        name: this.names[p.player] || p.name || `Player ${p.player + 1}`,
        room: p.room, floor: p.floor, connected: p.alive, hasKey: p.hasKey,
        pickedThisRound: p.picked, inChallenge: p.challenge,
        hint: p.hint,
        options: p.options.map(o => ({ key: o.key, say: o.say, leadsTo: o.room, sealed: o.sealed || undefined, padlock: o.locked || undefined })),
      })),
      secret: secrets ? { stoneRoom: secrets.stoneRoom, keyRoom: secrets.keyRoom, keyHiddenIn: secrets.keyIn, mabelIsIn: secrets.mabelRoom } : null,
      recentEvents: this.events.slice(-10),
      youJustSaid: this.spoken.slice(-4),
      playersOnCall: this.deps.playersNow(),
      tilesOnScreen: this.deps.tiles?.() ?? null,
    };
    const messages = [
      { role: 'system', content: PERSONA },
      { role: 'system', content: `Live game state (do not read it out):\n${JSON.stringify(view)}` },
      ...this.history.slice(-12),
      { role: 'user', content: `${who}: "${text}"${why ? ` (the game could not run this directly: ${why})` : ''}` },
    ];
    let res = null, last = null;
    for (const model of this.model ? [this.model, ...MODELS().filter(m => m !== this.model)] : MODELS()) {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.65, max_tokens: 150 }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) { this.model = model; break; }
      const detail = (await res.text()).slice(0, 200);
      last = new Error(`OpenAI ${res.status}: ${detail}`);
      if (![400, 404].includes(res.status) || !/model/i.test(detail)) break;
      console.error(`[brain] ${model} unavailable, trying the next model`);
    }
    if (!res?.ok) throw last || new Error('OpenAI request failed');
    const msg = (await res.json()).choices?.[0]?.message || {};
    const said = cleanLine(msg.content || '');
    const calls = msg.tool_calls || [];
    this.history.push({ role: 'user', content: `${who}: "${text}"` });

    const done = [];
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { continue; }
      const p = (args.player || 1) - 1;
      if (call.function.name === 'choose_option') done.push(`${args.option} for ${this.names[p] || `P${p + 1}`}: ${await game.choose(p, args.option)}`);
      else if (call.function.name === 'challenge_action') done.push(`${args.action} for ${this.names[p] || `P${p + 1}`}: ${await game.signal(p, args.action)}`);
      else if (call.function.name === 'start_game') { this.deps.startGame(args.players || 1, text); done.push('started game'); }
    }
    if (said) await game.say('chert', said);
    this.history.push({ role: 'assistant', content: [said || '(stayed quiet)', done.length ? `[did: ${done.join('; ')}]` : ''].join(' ').trim() });
    if (this.history.length > 24) this.history.splice(0, this.history.length - 24);
    console.log(`[brain] ${who}: "${text}" -> ${said ? `"${said}"` : '(quiet)'}${done.length ? ` [${done.join('; ')}]` : ''}`);
  }
}
