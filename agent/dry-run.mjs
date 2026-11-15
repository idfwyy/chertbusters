// Exercise the call-view layout locally; camera debugging is opt-in and left-player only.
import { openGame } from './game.mjs';
const args = process.argv.slice(2);
if (args.some(arg => !['--camera', '--no-camera', '--help'].includes(arg)) || (args.includes('--camera') && args.includes('--no-camera'))) {
  console.error('Usage: npm run dry-run -- [--camera | --no-camera]');
  process.exit(1);
}
if (args.includes('--help')) {
  console.log('Usage: npm run dry-run -- [--camera | --no-camera]\nDefault: no camera. --camera enables the webcam for Batman (left) only.');
  process.exit(0);
}
const camera = args.includes('--camera');

const game = await openGame({
  dir: process.env.GAME_DIR || new URL('../game/', import.meta.url).pathname,
  show: true,
  query: `&dryrun=1&autostart=2${camera ? '&localcam=1' : ''}`,
});
console.log(`Mouse-only dry run: two players, room maps, ${camera ? 'webcam on the left only' : 'no camera'}, no ghost attacks, no time limit.`);
console.log('Click the room and search buttons. Press Ctrl+C here to close.');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await game.close();
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
