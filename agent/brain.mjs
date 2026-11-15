// Chert's brain: a ChatGPT model that sees the game and decides what Chert says and does.
//
// Clear commands ("left", "search the desk") never wait for the brain: the game runs them at once.
// Everything else comes here: questions, unclear speech, "where do I go?", "repeat that", "I can't hear you",
// someone leaving the call, a crash. The brain answers in Chert's voice and can act through three tools.
import { cleanLine } from './voice.mjs';

const MODELS = () => [...new Set([process.env.BRAIN_MODEL || 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini'])];

const PERSONA = `You are Chert, a real character: a small, warm, slightly panicked orange stone with a telephone headset, on a live FaceTime call.
Story: Mabel, the ghost of a 1926 switchboard operator, stole your spark stone and sealed it in a room upstairs in Hollow Line Manor. Without it you can't connect calls and your signal is dying. The players search the house for Mabel's brass key, find the red glowing door upstairs, unlock it, and strike your stone. The first to strike it wins.
Players: the left side is Batman, the right side is Spider-Man. If there is one player, it is Batman. Each player moves independently. The screen shows doors and searchable items. Mabel may challenge players to freeze, turn on a light, stay quiet, hold up a palm, show metal, or strike the stone.

Speak naturally in one or two short sentences. Answer any question about the story, Mabel, the house, controls, or anything else. In the lobby, respond to the callers' comments naturally and steer back to asking for help. On the call_started situation, explain your predicament in your own words and ask for help. Never repeat the opening greeting.
Decide when callers agree to help and call start_game; do not start merely because you asked them a question. The application chooses one or two players from detected caller tiles, never from your guess. On the game_started situation, explain the controls once in your own words: point to walk, fist to search, palm to use stairs or stop Mabel, and say your hero's name with voice commands.
During play, answer questions and comments naturally, but do not narrate every move or ask what next. Use the live hint data when asked about the key or stone. Do not list options; the screen shows them.
When a player clearly wants a move, call choose_option for that player. If the player or option is ambiguous, stay silent; never ask who. Only call challenge_action when the player is in that challenge and their words say they did it. Do not mention tools, JSON, or being an AI model unless asked directly.`;

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
    this.enabled = Boolean(process.env.OPENAI_API_KEY);
    if (!this.enabled) console.error('[brain] OPENAI_API_KEY is missing.');
  }

  /** Remember a game event so the brain knows what just happened. */
  note(line) { this.events.push(line); if (this.events.length > 18) this.events.shift(); }
  heardChert(who, text) { this.spoken.push(`${who === 'mabel' ? 'Mabel' : 'Chert'}: ${text}`); if (this.spoken.length > 6) this.spoken.shift(); }

  /** A player said something the game could not run directly. player is 0/1, or -1 if unknown. */
  hear(player, text, why = '') {
    const controller = new AbortController();
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      if (error) console.error('[brain]', error.message);
      this.deps.filler?.();
    };
    const timer = setTimeout(() => fail(new Error('response timed out')), 4000);
    const run = async () => {
      if (settled) return;
      try {
        await Promise.race([
          this.#think(player, text, why, controller.signal),
          new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })),
        ]);
        if (!settled) { settled = true; clearTimeout(timer); }
      } catch (error) { fail(error); }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  situation(text) { return this.hear(-1, text, 'situation'); }

  async #think(player, text, why, signal) {
    if (!this.enabled) throw new Error('OPENAI_API_KEY is missing');
    const { game } = this.deps;
    const [state, secrets] = await Promise.all([game.state().catch(() => null), game.secrets().catch(() => null)]);
    signal.throwIfAborted();
    const who = player >= 0 ? `${this.names[player] || `Player ${player + 1}`}` : 'Someone on the call';
    const view = {
      phase: this.deps.phase(),
      round: state?.round, chertSignalBars: state?.signal, keyFound: state?.keyFound, redDoorFound: state?.sealedRoomFound,
      players: (state?.players || []).map(p => ({
        player: p.player + 1,
        name: this.names[p.player] || p.name || `Player ${p.player + 1}`,
        room: p.room, floor: p.floor, connected: p.alive, hasKey: p.hasKey,
        pickedThisRound: p.picked, inChallenge: p.challenge,
        hint: p.hint, stoneHint: p.stoneHint,
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
      { role: 'user', content: why === 'situation' ? `[Situation: ${text}]` : `${who}: "${text}"${why ? ` (context: ${why})` : ''}` },
    ];
    let res = null, last = null;
    for (const model of this.model ? [this.model, ...MODELS().filter(m => m !== this.model)] : MODELS()) {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.65, max_tokens: 150 }),
        signal,
      });
      if (res.ok) { this.model = model; break; }
      const detail = (await res.text()).slice(0, 200);
      last = new Error(`OpenAI ${res.status}: ${detail}`);
      if (![400, 404].includes(res.status) || !/model/i.test(detail)) break;
      console.error(`[brain] ${model} unavailable, trying the next model`);
    }
    signal.throwIfAborted();
    if (!res?.ok) throw last || new Error('OpenAI request failed');
    const msg = (await res.json()).choices?.[0]?.message || {};
    signal.throwIfAborted();
    const said = cleanLine(msg.content || '');
    const calls = msg.tool_calls || [];
    this.history.push({ role: 'user', content: `${who}: "${text}"` });

    const done = [];
    let started = false;
    for (const call of calls) {
      signal.throwIfAborted();
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { continue; }
      const p = (args.player || 1) - 1;
      if (call.function.name === 'choose_option') done.push(`${args.option} for ${this.names[p] || `P${p + 1}`}: ${await game.choose(p, args.option)}`);
      else if (call.function.name === 'challenge_action') done.push(`${args.action} for ${this.names[p] || `P${p + 1}`}: ${await game.signal(p, args.action)}`);
      else if (call.function.name === 'start_game') {
        started = this.deps.startGame(args.players || 1, text) !== false;
        done.push(started ? 'started game' : 'start ignored');
      }
    }
    signal.throwIfAborted();
    if (said && !started) await game.say('chert', said);
    this.history.push({ role: 'assistant', content: [started ? '(started game)' : said || '(stayed quiet)', done.length ? `[did: ${done.join('; ')}]` : ''].join(' ').trim() });
    if (this.history.length > 24) this.history.splice(0, this.history.length - 24);
    if (started) void this.situation('game_started');
    console.log(`[brain] ${who}: "${text}" -> ${said ? `"${said}"` : '(quiet)'}${done.length ? ` [${done.join('; ')}]` : ''}`);
  }
}
