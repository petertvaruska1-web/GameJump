// Keyboard + mouse (pointer lock) input with edge detection.

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  mouseClicked = false;
  /** Right mouse button pressed this frame (grapple). */
  mouseRightPressed = false;
  locked = false;
  onLockChange?: (locked: boolean) => void;
  onKey?: (code: string) => void;
  /** When false, gameplay keys are ignored (menus). */
  enabled = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab', 'F3', 'F4', 'F6', 'F7', 'F8'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      this.onKey?.(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => { this.down.clear(); });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseClicked = true;
      if (e.button === 2) this.mouseRightPressed = true;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.down.clear();
      this.onLockChange?.(this.locked);
    });
  }

  requestLock() {
    if (this.locked) return;
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
    this.mouseRightPressed = false;
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}
