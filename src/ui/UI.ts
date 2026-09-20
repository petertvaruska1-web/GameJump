// DOM user interface: main menu, join, how-to-play, settings, lobby, HUD,
// pause menu, results and error dialogs. Minimal during gameplay.

import { MAX_PLAYERS } from '../../shared/constants';
import { Status, type LobbyPlayer, type MatchResult, type Phase } from '../../shared/protocol';
import { PLAYER_CSS } from '../render/CharacterModel';
import type { Settings } from '../settings';
import './styles.css';

export interface UIHandlers {
  create(name: string): void;
  join(name: string, code: string): void;
  offline(name: string): void;
  ready(r: boolean): void;
  start(): void;
  leave(): void;
  resume(): void;
  toLobby(): void;
  settingsChanged(s: Settings): void;
  click(): void;
}

export interface LobbyView {
  code: string;
  phase: Phase;
  hostId: number;
  players: LobbyPlayer[];
  meId: number;
  offline: boolean;
}

export interface HudPlayer { id: number; name: string; status: Status; me: boolean; connected: boolean }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CONTROLS = `
  <div class="keys">
    <span><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></span><span>Move (relative to the camera)</span>
    <span><kbd>Mouse</kbd></span><span>Look around</span>
    <span><kbd>Space</kbd></span><span>Jump — every jump is full height, just tap it</span>
    <span><kbd>Space</kbd> in the air</span><span>Front flip — a tuck that carries the jump further</span>
    <span><kbd>W</kbd> at a ledge</span><span>Climb — hold forward and you pull yourself up</span>
    <span><kbd>Q</kbd> / <kbd>E</kbd></span><span>Dash left / right — steps you out of a charge, on the ground or in the air</span>
    <span><kbd>Shift</kbd></span><span>Sprint — needed for long gaps</span>
    <span><kbd>C</kbd></span><span>Slide — while running: under low gaps and chest-high lasers</span>
    <span><kbd>Right mouse</kbd></span><span>Grapple a green anchor in view · press again or Space to let go</span>
    <span><kbd>Esc</kbd></span><span>Pause menu / release the mouse</span>
  </div>`;

export class UI {
  private screen: HTMLElement | null = null;
  private hud: HTMLElement;
  private overlay: HTMLElement | null = null;
  private bigTimer = 0;
  private objectiveTimer = 0;
  private lastLobby: LobbyView | null = null;

  constructor(private root: HTMLElement, private settings: Settings, private h: UIHandlers) {
    this.hud = el(`<div id="hud" class="hidden">
      <div class="hud-players"></div>
      <div class="hud-objective"></div>
      <div class="hud-timer"></div>
      <div class="hud-center"></div>
      <div class="hud-bottom"></div>
      <div class="hud-powers"></div>
      <div class="hud-reticle hidden"><span>E</span></div>
      <div class="toast-stack"></div>
      <div class="capture-hint hidden">Click to capture the mouse</div>
      <div id="debug" class="hidden"></div>
    </div>`);
    root.appendChild(this.hud);
  }

  // ------------------------------------------------------------------ helpers

  private show(html: string, cls = 'screen left'): HTMLElement {
    this.screen?.remove();
    const s = el(`<div class="${cls} interactive">${html}</div>`);
    this.root.appendChild(s);
    this.screen = s;
    s.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b && !b.disabled) this.h.click();
    });
    return s;
  }

  hideScreen() { this.screen?.remove(); this.screen = null; }

  private closeOverlay() { this.overlay?.remove(); this.overlay = null; }

  get overlayOpen() { return this.overlay !== null; }

  // ------------------------------------------------------------------ menus

  loading(text: string) {
    this.show(`<div class="loading"><div class="title">SKYFALL <span>ESCAPE</span></div><div class="hint">${esc(text)}</div><div class="bar"><div></div></div></div>`, 'screen');
  }

  mainMenu(notice?: string) {
    this.hud.classList.add('hidden');
    const s = this.show(`<div>
      <h1 class="title">Skyfall<br/><span>Escape</span></h1>
      <p class="tagline">Keep moving. Don't fall. Don't get seen.</p>
      <div class="field name-row"><label>Runner name</label><input class="input" id="name" maxlength="16" placeholder="Enter a name" value="${esc(this.settings.name)}"/></div>
      <div class="menu">
        <button class="btn primary" data-a="play">Play — create game</button>
        <button class="btn" data-a="join">Join game</button>
        <button class="btn" data-a="offline">Solo offline</button>
        <button class="btn" data-a="how">How to play</button>
        <button class="btn" data-a="settings">Settings</button>
      </div>
      ${notice ? `<p class="hint" style="margin-top:18px;max-width:360px">${esc(notice)}</p>` : ''}
    </div>`);
    const name = s.querySelector<HTMLInputElement>('#name')!;
    const getName = () => { const n = name.value.trim(); this.settings.name = n; this.h.settingsChanged(this.settings); return n; };
    s.querySelector('[data-a=play]')!.addEventListener('click', () => this.h.create(getName()));
    s.querySelector('[data-a=join]')!.addEventListener('click', () => { getName(); this.joinMenu(); });
    s.querySelector('[data-a=offline]')!.addEventListener('click', () => this.h.offline(getName()));
    s.querySelector('[data-a=how]')!.addEventListener('click', () => { getName(); this.howTo(() => this.mainMenu()); });
    s.querySelector('[data-a=settings]')!.addEventListener('click', () => { getName(); this.settingsMenu(() => this.mainMenu()); });
  }

  joinMenu(error?: string) {
    const s = this.show(`<div class="panel">
      <h2>Join game</h2>
      <div class="field"><label>Room code</label><input class="input code" id="code" maxlength="4" placeholder="ABCD" autocomplete="off" spellcheck="false"/></div>
      ${error ? `<p style="color:var(--danger)">${esc(error)}</p>` : '<p class="hint">Ask the host for the 4-letter code shown in their lobby.</p>'}
      <div class="row end"><button class="btn small" data-a="back">Back</button><button class="btn small primary" data-a="go">Join</button></div>
    </div>`, 'screen center');
    const code = s.querySelector<HTMLInputElement>('#code')!;
    code.focus();
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    const go = () => { if (code.value.length >= 4) this.h.join(this.settings.name, code.value); else code.focus(); };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') this.mainMenu(); });
    s.querySelector('[data-a=go]')!.addEventListener('click', go);
    s.querySelector('[data-a=back]')!.addEventListener('click', () => this.mainMenu());
  }

  private howToHtml() {
    return `<h2>How to play</h2>
      <p>Reach the glowing <b style="color:var(--cyan)">beacon on the Spire</b> at the far side of the ruins. One slip and you fall — there are no checkpoints and no second chances.</p>
      <h3>Controls</h3>${CONTROLS}
      <h3>Movement</h3>
      <ul>
        <li>Sprint before long jumps. Running alone will not clear the big gaps.</li>
        <li>Jumps forgive a late press at the edge, and a press just before landing.</li>
        <li>Grab ledges: jump at a wall up to chest height and you pull yourself up. Low obstacles are vaulted automatically.</li>
        <li><b>Climb</b>: no key for it — hold forward. Come up short on a jump and you catch the lip and pull yourself up; walk into something between waist and head height and lean on it for a moment and you climb that too. Anything taller stays unclimbable, the pull-up leaves you helpless while it plays, and there is a pause before the next one, so you cannot ladder your way out of trouble.</li>
        <li><b>Front flip</b>: press <kbd>Space</kbd> again while you are in the air — right after the jump or seconds into a long fall, it does not matter. You tuck and turn, and the flip adds about 0.9 m to the jump without going any higher. One per jump. Mid-flip you are a low target: a Sentinel that fires while you are tucked aims under your chest and the shot passes over you as you land.</li>
        <li><b>Dash</b> (<kbd>Q</kbd> left, <kbd>E</kbd> right): a 2.6 m sidestep out of whatever is coming at you, ready again the moment it ends. A Stalker charging head-on cannot turn with it — dash when it is two to four metres out. It works in the air too (once per jump), thrown across your flight path so it never carries a jump further, and on the ground it ends at running speed. It will happily carry you off a ledge, so look before you go.</li>
        <li>Rust-coloured slabs crumble shortly after you step on them. Keep moving.</li>
        <li>Watch for wind gusts on narrow beams, rotating arms, and moving platforms.</li>
      </ul>
      <h3>Obstacles</h3>
      <ul>
        <li><b>Zip lines</b>: jump into a cable to grab it and slide down. <kbd>Space</kbd> lets go early.</li>
        <li><b>Launch pads</b>: step on one and you are thrown onto the next platform. You can steer a little in the air.</li>
        <li><b>Lasers</b> kill on contact. Gates blink (they flicker just before switching on), low beams can be jumped.</li>
        <li><b>Conveyor belts</b> carry you: run against them, steer across them, or ride a boost belt into a long jump.</li>
      </ul>
      <h3>Slide and grapple</h3>
      <ul>
        <li><b>Slide</b> (<kbd>C</kbd> while running): you drop low and keep your speed. Slide under jammed shutters and chest-high lasers, down stairs faster, and under shots aimed at your chest. Stalkers are too tall to follow you through low gaps. Jumping out of a slide goes a little further than a normal jump.</li>
        <li><b>Grapple</b> (right mouse): hook a glowing green anchor when the reticle marks it. The hook yanks you off your feet and toward the anchor, so you can fire it standing still — no need to jump first. The rope reels itself tight, and holding a direction pushes you along the arc, so steer with <kbd>W</kbd>/<kbd>A</kbd>/<kbd>S</kbd>/<kbd>D</kbd> and let go (press again or <kbd>Space</kbd>) as you swing up. Some anchors are required; others are rescue points beside hard jumps.</li>
      </ul>
      <h3>Power crates</h3>
      <ul>
        <li>Rare glowing crates: walk through one to take it. The first runner to reach a crate gets it.</li>
        <li><b style="color:#5ef0ff">Shield</b> soaks one hit (a stalker, drone, shot or laser) and staggers the attacker. It does not save you from falling.</li>
        <li><b style="color:#c38bff">Cloak</b>: for 15 seconds enemies cannot see you, and any that were chasing you lose you.</li>
        <li><b style="color:#ffa640">Jet boots</b>: for 22 seconds you can jump once more in mid-air.</li>
      </ul>
      <h3>Enemies</h3>
      <ul>
        <li><b>Stalkers</b> guard areas and run you down on sight. Outrun them or climb where they cannot follow.</li>
        <li><b>Sentinels</b> sweep a searchlight and fire slow energy shots. Keep cover between you and them.</li>
        <li><b>Drones</b> fly after you, even vertically. Hide behind structures until they give up.</li>
        <li>Enemies only chase what they can <i>see</i>. Break line of sight and they search, then return to their post.</li>
      </ul>
      <h3>Routes</h3>
      <p>Three main routes split and rejoin. The safer-looking one may be much longer; the fast one may have brutal jumps or open sightlines. Teammates can split up — anyone who dies keeps watching the others.</p>`;
  }

  howTo(back: () => void) {
    const s = this.show(`<div class="panel">${this.howToHtml()}<div class="row end" style="margin-top:18px"><button class="btn small primary" data-a="back">Back</button></div></div>`, 'screen center');
    s.querySelector('[data-a=back]')!.addEventListener('click', back);
  }

  private settingsHtml() {
    const s = this.settings;
    return `<h2>Settings</h2>
      <div class="setting"><span>Mouse sensitivity</span><input type="range" id="sens" min="0.2" max="3" step="0.05" value="${s.sensitivity}"/><span class="val" id="sensv">${s.sensitivity.toFixed(2)}</span></div>
      <div class="setting"><span>Field of view</span><input type="range" id="fov" min="60" max="95" step="1" value="${s.fov}"/><span class="val" id="fovv">${s.fov}</span></div>
      <div class="setting"><span>Master volume</span><input type="range" id="vol" min="0" max="1" step="0.05" value="${s.volume}"/><span class="val" id="volv">${Math.round(s.volume * 100)}</span></div>
      <div class="setting"><span>Music / tension</span><input type="range" id="mus" min="0" max="1" step="0.05" value="${s.music}"/><span class="val" id="musv">${Math.round(s.music * 100)}</span></div>
      <div class="setting"><span>Graphics quality</span><select id="q"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><span class="val"></span></div>
      <label class="check"><input type="checkbox" id="inv" ${s.invertY ? 'checked' : ''}/> Invert mouse Y</label>
      <label class="check"><input type="checkbox" id="shake" ${s.cameraShake ? 'checked' : ''}/> Camera shake</label>
      <label class="check"><input type="checkbox" id="fps" ${s.showFps ? 'checked' : ''}/> Show FPS</label>
      <p class="hint">Graphics quality applies after reloading the page.</p>`;
  }

  private bindSettings(root: HTMLElement) {
    const s = this.settings;
    const q = root.querySelector<HTMLSelectElement>('#q')!;
    q.value = s.quality;
    const bind = (id: string, fn: (v: string, t: HTMLInputElement) => void) => {
      const i = root.querySelector<HTMLInputElement>('#' + id)!;
      i.addEventListener('input', () => { fn(i.value, i); this.h.settingsChanged(s); });
    };
    bind('sens', (v) => { s.sensitivity = +v; root.querySelector('#sensv')!.textContent = (+v).toFixed(2); });
    bind('fov', (v) => { s.fov = +v; root.querySelector('#fovv')!.textContent = v; });
    bind('vol', (v) => { s.volume = +v; root.querySelector('#volv')!.textContent = String(Math.round(+v * 100)); });
    bind('mus', (v) => { s.music = +v; root.querySelector('#musv')!.textContent = String(Math.round(+v * 100)); });
    bind('inv', (_v, t) => { s.invertY = t.checked; });
    bind('shake', (_v, t) => { s.cameraShake = t.checked; });
    bind('fps', (_v, t) => { s.showFps = t.checked; });
    q.addEventListener('change', () => { s.quality = q.value as Settings['quality']; this.h.settingsChanged(s); });
  }

  settingsMenu(back: () => void) {
    const s = this.show(`<div class="panel">${this.settingsHtml()}<div class="row end" style="margin-top:14px"><button class="btn small primary" data-a="back">Back</button></div></div>`, 'screen center');
    this.bindSettings(s);
    s.querySelector('[data-a=back]')!.addEventListener('click', back);
  }

  // ------------------------------------------------------------------ lobby

  lobby(v: LobbyView) {
    this.hud.classList.add('hidden');
    this.closeOverlay();
    this.lastLobby = v;
    const me = v.players.find((p) => p.id === v.meId);
    const isHost = v.hostId === v.meId;
    const others = v.players.filter((p) => p.id !== v.hostId && p.connected);
    const allReady = others.every((p) => p.ready);
    const slots: string[] = [];
    for (let i = 1; i <= (v.offline ? 1 : MAX_PLAYERS); i++) {
      const p = v.players.find((q) => q.id === i);
      if (!p) { slots.push(`<div class="slot empty"><span class="dot" style="background:${PLAYER_CSS[i - 1]}"></span><div><div class="name">PLAYER ${i}</div><div class="meta">Open slot</div></div><span class="tag">Waiting</span></div>`); continue; }
      const tag = !p.connected ? '<span class="tag bad">Disconnected</span>' : p.host ? '<span class="tag warn">Host</span>' : p.ready ? '<span class="tag ok">Ready</span>' : '<span class="tag">Not ready</span>';
      slots.push(`<div class="slot"><span class="dot" style="background:${PLAYER_CSS[(p.id - 1) % 3]}"></span><div><div class="name">${esc(p.name)}${p.id === v.meId ? ' <span class="hint">(you)</span>' : ''}</div><div class="meta">Player ${p.id} · ${p.connected ? 'Connected' : 'Connection lost'}</div></div>${tag}</div>`);
    }
    const hint = v.offline ? 'Offline solo run: the whole game runs in your browser. Use Play to host an online game for friends.' : isHost
      ? (others.length === 0 ? 'You can start solo, or share the code so friends can join (up to 3 players).' : allReady ? 'Everyone is ready.' : 'Waiting for players to ready up…')
      : 'Waiting for the host to start the run.';
    const s = this.show(`<div class="panel">
      <h2>Lobby</h2>
      ${v.offline ? '<p class="hint">Offline solo run — no server needed.</p>' : `<div class="code-box"><div><small>Room code</small><div class="code">${esc(v.code)}</div></div><button class="btn small" data-a="copy">Copy</button></div>`}
      <div class="slots">${slots.join('')}</div>
      <p class="hint">${hint}</p>
      <div class="row between" style="margin-top:12px">
        <button class="btn small danger" data-a="leave">Leave</button>
        <div class="row">
          ${!isHost ? `<button class="btn small ${me?.ready ? '' : 'primary'}" data-a="ready">${me?.ready ? 'Not ready' : 'Ready'}</button>` : ''}
          ${isHost ? `<button class="btn primary center" data-a="start" ${allReady ? '' : 'disabled'}>Start run</button>` : ''}
        </div>
      </div>
      <details style="margin-top:16px"><summary class="hint" style="cursor:pointer">Controls</summary>${CONTROLS}</details>
    </div>`, 'screen center');
    s.querySelector('[data-a=leave]')!.addEventListener('click', () => this.h.leave());
    s.querySelector('[data-a=ready]')?.addEventListener('click', () => this.h.ready(!me?.ready));
    s.querySelector('[data-a=start]')?.addEventListener('click', () => this.h.start());
    s.querySelector('[data-a=copy]')?.addEventListener('click', (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      navigator.clipboard?.writeText(v.code).then(() => { b.textContent = 'Copied'; }).catch(() => { b.textContent = v.code; });
    });
  }

  get lobbyState() { return this.lastLobby; }

  // ------------------------------------------------------------------ HUD

  showHud() {
    this.hideScreen();
    this.hud.classList.remove('hidden');
  }

  hudPlayers(list: HudPlayer[]) {
    const box = this.hud.querySelector('.hud-players')!;
    box.innerHTML = list.map((p) => {
      const st = !p.connected && p.status === Status.Alive ? ['lost', 'Reconnecting'] : p.status === Status.Alive ? ['alive', 'Alive'] : p.status === Status.Dead ? ['dead', 'Dead'] : p.status === Status.Finished ? ['finished', 'Escaped'] : ['left', 'Left'];
      return `<div class="hud-player ${p.me ? 'me' : ''}" style="border-left-color:${PLAYER_CSS[(p.id - 1) % 3]}"><span class="n">${esc(p.name)}</span><span class="s ${st[0]}">${st[1]}</span></div>`;
    }).join('');
  }

  timer(sec: number | null) {
    const t = this.hud.querySelector('.hud-timer')!;
    t.textContent = sec === null ? '' : fmtTime(sec);
  }

  objective(text: string, seconds = 6) {
    const o = this.hud.querySelector<HTMLElement>('.hud-objective')!;
    o.textContent = text;
    o.style.opacity = '1';
    window.clearTimeout(this.objectiveTimer);
    this.objectiveTimer = window.setTimeout(() => { o.style.opacity = '0'; }, seconds * 1000);
  }

  big(text: string, cls = '', sub = '', seconds = 0) {
    const c = this.hud.querySelector('.hud-center')!;
    c.innerHTML = `<div class="big-msg ${cls}">${esc(text)}</div>${sub ? `<div class="sub-msg">${esc(sub)}</div>` : ''}`;
    window.clearTimeout(this.bigTimer);
    if (seconds > 0) this.bigTimer = window.setTimeout(() => { c.innerHTML = ''; }, seconds * 1000);
  }

  clearBig() { this.hud.querySelector('.hud-center')!.innerHTML = ''; }

  bottom(text: string) { this.hud.querySelector('.hud-bottom')!.textContent = text; }

  /** Active powers of the local runner (remaining = seconds left for timed ones). */
  powers(list: { name: string; color: string; remaining?: number; total?: number }[]) {
    const box = this.hud.querySelector<HTMLElement>('.hud-powers')!;
    const key = list.map((p) => `${p.name}${p.remaining === undefined ? '' : Math.ceil(p.remaining)}`).join('|');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = list.map((p) => {
      const bar = p.remaining !== undefined && p.total ? `<i style="width:${Math.max(0, Math.min(100, (p.remaining / p.total) * 100))}%;background:${p.color}"></i>` : '';
      const time = p.remaining !== undefined ? `<em>${Math.ceil(p.remaining)}s</em>` : '';
      return `<div class="hud-power" style="border-color:${p.color}"><b style="color:${p.color}">${esc(p.name)}</b>${time}${bar}</div>`;
    }).join('');
  }

  /** Grapple reticle at screen position (x, y) in pixels, or hidden. */
  reticle(x: number | null, y = 0, hooked = false) {
    const r = this.hud.querySelector<HTMLElement>('.hud-reticle')!;
    if (x === null) { r.classList.add('hidden'); return; }
    r.classList.remove('hidden');
    r.classList.toggle('hooked', hooked);
    r.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
  }

  captureHint(show: boolean) { this.hud.querySelector('.capture-hint')!.classList.toggle('hidden', !show); }

  toast(text: string, seconds = 4) {
    const stack = this.hud.querySelector('.toast-stack')!;
    const t = el(`<div class="toast">${esc(text)}</div>`);
    stack.appendChild(t);
    window.setTimeout(() => t.remove(), seconds * 1000);
    while (stack.children.length > 4) stack.firstElementChild?.remove();
  }

  debug(text: string | null) {
    const d = this.hud.querySelector<HTMLElement>('#debug')!;
    d.classList.toggle('hidden', text === null);
    if (text !== null) d.textContent = text;
  }

  // ------------------------------------------------------------------ overlays

  pause(isHost: boolean, offline: boolean) {
    this.closeOverlay();
    const o = el(`<div class="screen center interactive"><div class="panel" style="width:min(380px,92vw)">
      <h2>Paused</h2>
      ${offline ? '' : '<p class="hint">The world keeps moving while you are in this menu.</p>'}
      <div class="menu" style="width:100%">
        <button class="btn primary" data-a="resume">Resume</button>
        <button class="btn" data-a="settings">Settings</button>
        <button class="btn" data-a="how">How to play</button>
        ${isHost ? '<button class="btn" data-a="lobby">Return everyone to lobby</button>' : ''}
        <button class="btn danger" data-a="leave">Leave game</button>
      </div></div></div>`);
    this.root.appendChild(o);
    this.overlay = o;
    const panel = o.querySelector('.panel')!;
    const back = () => this.pause(isHost, offline);
    o.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) this.h.click(); });
    o.querySelector('[data-a=resume]')!.addEventListener('click', () => this.h.resume());
    o.querySelector('[data-a=settings]')!.addEventListener('click', () => {
      panel.innerHTML = `${this.settingsHtml()}<div class="row end" style="margin-top:14px"><button class="btn small primary" data-a="back">Back</button></div>`;
      this.bindSettings(panel as HTMLElement);
      panel.querySelector('[data-a=back]')!.addEventListener('click', back);
    });
    o.querySelector('[data-a=how]')!.addEventListener('click', () => {
      panel.innerHTML = `${this.howToHtml()}<div class="row end" style="margin-top:14px"><button class="btn small primary" data-a="back">Back</button></div>`;
      panel.querySelector('[data-a=back]')!.addEventListener('click', back);
    });
    o.querySelector('[data-a=lobby]')?.addEventListener('click', () => this.h.toLobby());
    o.querySelector('[data-a=leave]')!.addEventListener('click', () => this.h.leave());
  }

  closePause() { this.closeOverlay(); }

  results(results: MatchResult[], meId: number, isHost: boolean, duration: number) {
    this.closeOverlay();
    const me = results.find((r) => r.id === meId);
    const escaped = results.filter((r) => r.status === Status.Finished).length;
    const title = me?.status === Status.Finished ? 'You escaped' : escaped > 0 ? 'The team made it' : 'Nobody escaped';
    const rows = results.map((r) => {
      const status = r.status === Status.Finished ? `<span class="s finished">Escaped${r.place ? ` · #${r.place}` : ''}</span>`
        : r.status === Status.Dead ? `<span class="s dead">${causeText(r.cause)}</span>` : '<span class="s left">Left</span>';
      return `<tr><td><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PLAYER_CSS[(r.id - 1) % 3]};margin-right:10px"></span>${esc(r.name)}</td><td>${status}</td><td class="r">${fmtTime(r.time)}</td></tr>`;
    }).join('');
    const o = el(`<div class="screen center interactive"><div class="panel">
      <h2>${title}</h2>
      <table class="results">${rows}</table>
      <p class="hint">Run length ${fmtTime(duration)}. ${isHost ? '' : 'Waiting for the host to start another run…'}</p>
      <div class="row between"><button class="btn small danger" data-a="leave">Leave</button>${isHost ? '<button class="btn primary center" data-a="again">Back to lobby</button>' : ''}</div>
    </div></div>`);
    this.root.appendChild(o);
    this.overlay = o;
    o.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) this.h.click(); });
    o.querySelector('[data-a=leave]')!.addEventListener('click', () => this.h.leave());
    o.querySelector('[data-a=again]')?.addEventListener('click', () => this.h.toLobby());
  }

  modal(title: string, message: string, buttons: { label: string; primary?: boolean; fn: () => void }[]) {
    this.closeOverlay();
    const o = el(`<div class="screen center modal interactive"><div class="panel"><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="row end"></div></div></div>`);
    const row = o.querySelector('.row')!;
    for (const b of buttons) {
      const btn = el(`<button class="btn small ${b.primary ? 'primary' : ''}">${esc(b.label)}</button>`) as HTMLButtonElement;
      btn.addEventListener('click', () => { this.h.click(); this.closeOverlay(); b.fn(); });
      row.appendChild(btn);
    }
    this.root.appendChild(o);
    this.overlay = o;
  }

  closeModal() { this.closeOverlay(); }
}

export function fatal(title: string, message: string) {
  document.body.innerHTML = `<div class="fatal"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>`;
}

export function causeText(c?: string) {
  switch (c) {
    case 'fall': return 'Fell';
    case 'melee': return 'Caught';
    case 'shot': return 'Shot down';
    case 'flyer': return 'Taken by a drone';
    case 'laser': return 'Hit a laser';
    default: return 'Dead';
  }
}

export function fmtTime(sec: number) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}
