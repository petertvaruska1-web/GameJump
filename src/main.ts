import { Game } from './game/Game';
import { webglAvailable } from './render/Renderer';
import { loadSettings } from './settings';
import { fatal } from './ui/UI';
import './ui/styles.css';

function boot() {
  if (!webglAvailable()) {
    fatal(
      'WebGL 2 is not available',
      'Skyfall Escape needs a browser and graphics driver with WebGL 2 support (a recent Chrome, Edge or Firefox on desktop). ' +
        'Try updating your browser or graphics drivers, or enable hardware acceleration in the browser settings.',
    );
    return;
  }
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  try {
    const game = new Game(canvas, ui, loadSettings());
    (window as unknown as { game: Game }).game = game;
  } catch (err) {
    console.error(err);
    fatal('Something went wrong', `The game failed to start: ${(err as Error).message}. Reload the page to try again.`);
  }
}

window.addEventListener('error', (e) => console.error('[skyfall] uncaught', e.error ?? e.message));
boot();
