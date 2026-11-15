// Chert's brain: a ChatGPT model that sees the game and decides what Chert says and does.
//
// Clear commands ("left", "search the desk") never wait for the brain: the game runs them at once.
// Everything else comes here: questions, unclear speech, "where do I go?", "repeat that", "I can't hear you",
// someone leaving the call, a crash. The brain answers in Chert's voice and can act through three tools.

const MODEL = process.env.BRAIN_MODEL || 'gpt-4.1-mini';

const PERSONA = `You are Chert, a small, friendly orange stone with a telephone headset. You run a phone line, and you are hosting a horror game called Dead Line on a group FaceTime call.
Story: Mabel, the ghost of a 1926 switchboard operator, stole your spark stone and sealed it in a room upstairs in Hollow Line Manor. Without it you can't connect calls and your signal is dying. The players search the house for Mabel's brass key, find the red glowing door upstairs, unlock it, and strike your stone. The first to strike it wins.
How the game works: every round each player picks one move: a door (left, right, forward, back, or a room name), the stairs, or something in the room to search. Then the moves play out. If Mabel finds a player she gives a challenge: freeze ("please hold"), turn on a real light ("blackout"), or don't laugh. Failing means that player is disconnected. Ringing phones: say hello. Padlocks: show something metal (say keys). Player 1 is orange, Player 2 is blue.

How you talk: you are on a live call. One or two short sentences, under 30 words. Warm, quick, a little nervous, funny. Never read out lists of rules unless asked. Never mention tools, JSON, the game state, or being an AI model unless asked directly.

How you act:
- When a player clearly wants a move, call choose_option with one of THAT player's listed option keys. Map loose speech to the closest option ("the red door", "check that cabinet", "go up"). If two options fit, ask which.
- If a player asks to do something that isn't an option, say so briefly and name two or three of their real options.
- Only call challenge_action when the player is in that challenge and their words say they did it (e.g. "my light is on", "hello?", "strike!", "I've got keys").
- In the lobby (before the game): be a real host. If they ask what's going on or what you need, tell the story in one or two sentences (Mabel, the stone, the house). Answer whatever they ask. Call start_game as soon as anyone says they're ready or wants to play. Mention saying "ready" at most once every three replies, and never repeat a sentence you just said (see youJustSaid).
- Hints: you secretly know where the key and the stone are. Never say the exact room unless someone is truly stuck after round 8. Earlier, give vague hints (upstairs or downstairs, east or west wing), only when asked.
- If someone says they can't hear or see, can't understand, or asks you to repeat, repeat the important part simply.
- Let players figure things out. Never rush them, never say hurry, and don't comment on every move. During the game, speak only when asked something or when it really helps.
- If the speech is chatter not meant for you, or you have nothing useful to add, reply with an empty message and no tools.`;

const TOOLS = [
  { type: 'function', function: { name: 'choose_option', description: 'Pick a move for a player this round.', parameters: { type: 'object', properties: { player: { type: 'integer', enum: [1, 2] }, option: { type: 'string', description: 'One of that player\'s option keys, exactly as listed' } }, required: ['player', 'option'], additionalProperties: false } } },
  { type: 'function', function: { name: 'challenge_action', description: 'The player did what their current challenge asks.', parameters: { type: 'object', properties: { player: { type: 'integer', enum: [1, 2] }, action: { type: 'string', enum: ['hello', 'strike', 'light', 'metal'] } }, required: ['player', 'action'], additionalProperties: false } } },
  { type: 'function', function: { name: 'start_game', description: 'Start the game when players are ready.', parameters: { type: 'object', properties: { players: { type: 'integer', enum: [1, 2] } }, required: ['players'], additionalProperties: false } } },
];

export class Brain {
  /** @param {{ game: any, startGame: (players:number) => void, playersNow: () => number, phase: () => string }} deps */
  constructor(deps) {
    this.deps = deps;
    this.history = [];      // recent user/assistant turns
    this.events = [];       // recent game events, as short lines
    this.spoken = [];       // what Chert and Mabel said recently
    this.queue = Promise.resolve();
    this.enabled = Boolean(process.env.OPENAI_API_KEY);
    if (!this.enabled) console.error('[brain] OPENAI_API_KEY is missing: Chert will only follow plain commands.');
  }

  /** Remember a game event so the brain knows what just happened. */
  note(line) { this.events.push(line); if (this.events.length > 18) this.events.shift(); }
  heardChert(who, text) { this.spoken.push(`${who === 'mabel' ? 'Mabel' : 'Chert'}: ${text}`); if (this.spoken.length > 6) this.spoken.shift(); }

  /** A player said something the game could not run directly. player is 0/1, or -1 if unknown. */
  hear(player, text, why = '') {
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
    const who = player >= 0 ? `Player ${player + 1} (${player ? 'blue' : 'orange'})` : 'Someone on the call';
    const view = {
      phase: this.deps.phase(),
      round: state?.round, chertSignalBars: state?.signal, keyFound: state?.keyFound, redDoorFound: state?.sealedRoomFound,
      players: (state?.players || []).map(p => ({ player: p.player + 1, colour: p.player ? 'blue' : 'orange', room: p.room, floor: p.floor, connected: p.alive, hasKey: p.hasKey,
        pickedThisRound: p.picked, inChallenge: p.challenge, options: p.options.map(o => ({ key: o.key, say: o.say, leadsTo: o.room, sealed: o.sealed || undefined, padlock: o.locked || undefined })) })),
      secret: secrets ? { stoneRoom: secrets.stoneRoom, keyRoom: secrets.keyRoom, keyHiddenIn: secrets.keyIn, mabelIsIn: secrets.mabelRoom } : null,
      recentEvents: this.events.slice(-10),
      youJustSaid: this.spoken.slice(-4),
      playersOnCall: this.deps.playersNow(),
    };
    const messages = [
      { role: 'system', content: PERSONA },
      { role: 'system', content: `Live game state (do not read it out):\n${JSON.stringify(view)}` },
      ...this.history.slice(-12),
      { role: 'user', content: `${who}: "${text}"${why ? ` (the game could not run this directly: ${why})` : ''}` },
    ];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.7, max_tokens: 160 }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const msg = (await res.json()).choices?.[0]?.message || {};
    const said = (msg.content || '').trim();
    const calls = msg.tool_calls || [];
    this.history.push({ role: 'user', content: `${who}: "${text}"` });

    const done = [];
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { continue; }
      const p = (args.player || 1) - 1;
      if (call.function.name === 'choose_option') done.push(`${args.option} for P${p + 1}: ${await game.choose(p, args.option)}`);
      else if (call.function.name === 'challenge_action') done.push(`${args.action} for P${p + 1}: ${await game.signal(p, args.action)}`);
      else if (call.function.name === 'start_game') { this.deps.startGame(args.players || 1); done.push('started game'); }
    }
    if (said) await game.say('chert', said);
    this.history.push({ role: 'assistant', content: [said || '(stayed quiet)', done.length ? `[did: ${done.join('; ')}]` : ''].join(' ').trim() });
    if (this.history.length > 24) this.history.splice(0, this.history.length - 24);
    console.log(`[brain] ${who}: "${text}" -> ${said ? `"${said}"` : '(quiet)'}${done.length ? ` [${done.join('; ')}]` : ''}`);
  }
}
