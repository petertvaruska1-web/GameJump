// Keyboard + mouse (pointer lock) input with edge detection.

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  mouseClicked = false;
  /** Left mouse button pressed this frame while the mouse is captured (flight: take off / land; a power in the arena). */
  mouseLeftPressed = false;
  /** Left mouse button held down right now (lightning keeps firing while it is). */
  mouseLeftDown = false;
  /**
   * Hold Ctrl as a game key (flight descends with it): Ctrl shortcuts the page
   * is allowed to stop (Ctrl+D, Ctrl+S, ...) are swallowed while this is on.
   */
  trapCtrl = false;
  /** Right mouse button pressed this frame (grapple). */
  mouseRightPressed = false;
  /** Right mouse button held down right now (the grapple hangs on while it is). */
  mouseRightDown = false;
  /** Mouse wheel notches this frame (+ down, - up), while the mouse is captured. */
  wheel = 0;
  /**
   * Every left (0) and right (1) button press this frame while the mouse is captured,
   * in order, with the moment it happened (performance.now() time, ms): Speedster
   * Battle reads its strides from these, so fast clicks between frames all count.
   */
  readonly clicks: { b: 0 | 1; t: number }[] = [];
  locked = false;
  /**
   * A lock request is in flight. Starting a run asks for the mouse from the
   * button's click and again as the run begins; a second request on top of a
   * pending one could lose the lock, which the game reads as the player
   * pressing Esc, and "Run it again" landed on the pause menu.
   */
  private lockPending = false;
  private lockPendingAt = 0;
  onLockChange?: (locked: boolean) => void;
  onKey?: (code: string) => void;
  /** When false, gameplay keys are ignored (menus). */
  enabled = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10'].includes(e.code)) e.preventDefault();
      if (this.trapCtrl && (e.ctrlKey || e.code === 'ControlLeft' || e.code === 'ControlRight')) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      this.onKey?.(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => { this.down.clear(); this.mouseRightDown = false; this.mouseLeftDown = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouseClicked = true; if (this.locked) { this.mouseLeftPressed = true; this.mouseLeftDown = true; } }
      if (e.button === 2) { this.mouseRightPressed = true; this.mouseRightDown = true; }
      if (this.locked && (e.button === 0 || e.button === 2)) this.clicks.push({ b: e.button === 0 ? 0 : 1, t: e.timeStamp || performance.now() });
    });
    // on the window, so letting go over a menu or outside the page still counts
    window.addEventListener('mouseup', (e) => { if (e.button === 2) this.mouseRightDown = false; if (e.button === 0) this.mouseLeftDown = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockerror', () => { this.lockPending = false; });
    document.addEventListener('pointerlockchange', () => {
      this.lockPending = false;
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.down.clear(); this.mouseRightDown = false; this.mouseLeftDown = false; }
      this.onLockChange?.(this.locked);
    });
  }

  requestLock() {
    if (this.locked) return;
    // one request at a time (a request that never answers is given up after a second)
    if (this.lockPending && performance.now() - this.lockPendingAt < 1000) return;
    this.lockPending = true;
    this.lockPendingAt = performance.now();
    const quiet = (r: unknown) => { if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => { /* not allowed here */ }); };
    try {
      const r = this.canvas.requestPointerLock({ unadjustedMovement: true } as never) as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') {
        // raw input unsupported on some platforms: retry with default options
        (r as Promise<void>).catch(() => { try { quiet(this.canvas.requestPointerLock()); } catch { /* ignore */ } });
      }
    } catch {
      try { quiet(this.canvas.requestPointerLock()); } catch { /* ignore */ }
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string) { return this.enabled && this.down.has(code); }
  wasPressed(code: string) { return this.enabled && this.pressed.has(code); }
  wasReleased(code: string) { return this.released.has(code); }
  anyDown(...codes: string[]) { return codes.some((c) => this.isDown(c)); }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.mouseClicked = false;
    this.mouseLeftPressed = false;
    this.mouseRightPressed = false;
    this.wheel = 0;
    this.clicks.length = 0;
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}
