// Exercise the call-view layout locally; camera debugging is opt-in and left-player only.
import './logging.mjs';
import { openGame } from './game.mjs';
const args = process.argv.slice(2);
const usage = 'Usage: npm run dry-run -- [--players 1|2] [--camera | --no-camera]';
let players = 2, camera = false, sawCamera = false, sawNoCamera = false, bad = false;
const queue = [...args];
while (queue.length){
  const arg = queue.shift();
  if (arg === '--players'){
    const value = queue.shift();
    if (value !== '1' && value !== '2') bad = true;
    else players = +value;
  } else if (arg.startsWith('--players=')){
    const value = arg.slice('--players='.length);
    if (value !== '1' && value !== '2') bad = true;
    else players = +value;
  } else if (arg === '--camera') sawCamera = true;
  else if (arg === '--no-camera') sawNoCamera = true;
  else if (arg === '--help'){
    console.log(`${usage}\nDefault: two players, no camera. --camera enables the webcam for Batman (left) only.`);
    process.exit(0);
  } else bad = true;
}
if (bad || (sawCamera && sawNoCamera)){
  console.error(usage);
  process.exit(1);
}
if (sawCamera) camera = true;

const game = await openGame({
  dir: process.env.GAME_DIR || new URL('../game/', import.meta.url).pathname,
  show: true,
  query: `&dryrun=1&autostart=${players}${camera ? '&localcam=1' : ''}`,
});
console.log(`Mouse-only dry run: ${players === 1 ? 'one player' : 'two players'}, room maps, ${camera ? 'webcam on the left only' : 'no camera'}, no ghost attacks, no time limit.`);
console.log('Click Chert’s story message to enter the game. Use Back to intermission to return to it. Press Ctrl+C here to close.');
let closing = false;
async function close(){
  if (closing) return;
  closing = true;
  await game.close();
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
