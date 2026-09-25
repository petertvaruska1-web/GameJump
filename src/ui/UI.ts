// DOM user interface: main menu, join, how-to-play, settings, lobby, HUD,
// pause menu, results and error dialogs. Minimal during gameplay.

import { MAX_PLAYERS, SUPERS } from '../../shared/constants';
import { Status, type LobbyPlayer, type MatchResult, type Phase } from '../../shared/protocol';
import { POWER_INFO } from '../game/Powers';
import { PLAYER_CSS } from '../render/CharacterModel';
import { loadBest, type PersonalBest, type Settings } from '../settings';
import './styles.css';

export interface UIHandlers {
  create(name: string): void;
  join(name: string, code: string): void;
  offline(name: string): void;
  ready(r: boolean): void;
  start(): void;
  /** Straight into the Warden's arena (a rematch, or from the lobby once the beacon has been reached). */
  startBoss(): void;
  /** Throw away the run in progress and count down a new one (host alone in the room). */
  restart(): void;
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

export interface HudPlayer { id: number; name: string; status: Status; me: boolean; connected: boolean; hp?: number; power?: number }

/** How the fight with the Warden went, for the results screen. */
export interface FightSummary {
  won: boolean;
  /** Seconds from arriving in the arena to the Warden's fall. */
  time: number;
  /** This browser's best fight time before this one (null: the first win). */
  prevBest: number | null;
  best: boolean;
}

/** A line of dialogue on screen: who speaks, the line so far, and where we are in the speech. */
export interface DialogueView {
  name: string;
  text: string;
  /** Characters typed out so far. */
  shown: number;
  line: number;
  lines: number;
  /** The whole line is out and it waits for you. */
  waiting: boolean;
}

/** How the local runner's run went, for the results screen. */
export interface RunSummary {
  /** 0..1 of the way from the start line to the Spire. */
  progress: number;
  /** Named area where the run ended (null out over open air before the first one). */
  area: string | null;
  escaped: boolean;
  cause?: string;
  time: number;
  /** Best before this run, and which records this run broke. */
  prevBest: PersonalBest | null;
  further: boolean;
  faster: boolean;
  /** Flown with Viktor's gift: it does not count toward your records. */
  assisted?: boolean;
}

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
    <span><kbd>Right mouse</kbd></span><span>Hold to grapple a green anchor in view · let go (or Space) to drop off</span>
    <span><kbd>Esc</kbd></span><span>Pause menu / release the mouse</span>
  </div>`;

/** Flight controls, shown once Viktor has granted it (the tip card and the how-to). */
export const FLIGHT_TIP = 'Flight: left click takes off and lands. Space climbs, Ctrl (or C) sinks, Shift flies faster, and W flies wherever you look.';

export class UI {
  private screen: HTMLElement | null = null;
  private hud: HTMLElement;
  private overlay: HTMLElement | null = null;
  private bigTimer = 0;
  private objectiveTimer = 0;
  private tipTimer = 0;
  /** White light over the whole screen (the portal and the blessing). */
  private readonly fade: HTMLElement;
  private lastLobby: LobbyView | null = null;
  /** What Esc does on the current menu screen (back out of a sub-page), if anything. */
  private escBack: (() => void) | null = null;

  constructor(private root: HTMLElement, private settings: Settings, private h: UIHandlers) {
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.escBack || !this.screen || this.overlay) return;
      if ((e.target as HTMLElement | null)?.id === 'code') return; // the join box handles its own Esc
      const back = this.escBack;
      this.h.click();
      back();
    });
    this.hud = el(`<div id="hud" class="hidden">
      <div class="hud-players"></div>
      <div class="hud-objective"></div>
      <div class="hud-tip hidden"></div>
      <div class="hud-timer"></div>
      <div class="hud-area"><span class="area-name"></span><i class="area-bar"><b></b></i></div>
      <div class="hud-center"></div>
      <div class="hud-bottom"></div>
      <div class="hud-powers"></div>
      <div class="hud-reticle hidden"><span>RMB</span></div>
      <div class="hud-cine"><i></i><i></i></div>
      <div class="hud-interact hidden"><kbd>E</kbd><span></span></div>
      <div class="hud-dialogue hidden"><div class="dlg-name"></div><div class="dlg-text"></div><div class="dlg-foot"><span class="dlg-dots"></span><span class="dlg-hint"><kbd>E</kbd> continue</span></div></div>
      <div class="toast-stack"></div>
      <div class="capture-hint hidden">Click to capture the mouse</div>
      <div id="debug" class="hidden"></div>
    </div>`);
    root.appendChild(this.hud);
    this.fade = el('<div id="heaven-fade"></div>');
    root.parentElement?.insertBefore(this.fade, root);
  }

  // ------------------------------------------------------------------ helpers

  private show(html: string, cls = 'screen left', escBack: (() => void) | null = null): HTMLElement {
    this.screen?.remove();
    this.escBack = escBack;
    const s = el(`<div class="${cls} interactive">${html}</div>`);
    this.root.appendChild(s);
    this.screen = s;
    s.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b && !b.disabled) this.h.click();
    });
    return s;
  }

  hideScreen() { this.screen?.remove(); this.screen = null; this.escBack = null; }

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
      ${touchOnly() ? '<p class="notice">Skyfall Escape is played with a keyboard and mouse. You can look around here, but you will need a computer to run the course.</p>' : ''}
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
    </div>`, 'screen center', () => this.mainMenu());
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
        <li><b>Grapple</b> (right mouse): hook a glowing green anchor when the reticle marks it. The hook yanks you off your feet and toward the anchor, so you can fire it standing still — no need to jump first. The rope reels itself tight, and holding a direction pushes you along the arc, so steer with <kbd>W</kbd>/<kbd>A</kbd>/<kbd>S</kbd>/<kbd>D</kbd>. You hang on while you hold the button: let go of it (or press <kbd>Space</kbd>) as you swing up. Some anchors are required; others are rescue points beside hard jumps.</li>
      </ul>
      <h3>Power crates</h3>
      <ul>
        <li>Rare glowing crates: walk through one to take it. The first runner to reach a crate gets it.</li>
        <li><b style="color:#5ef0ff">Shield</b> soaks one hit (a stalker, drone, shot or laser) and staggers the attacker. It does not save you from falling.</li>
        <li><b style="color:#c38bff">Cloak</b>: for 15 seconds enemies cannot see you, and any that were chasing you lose you.</li>
        <li><b style="color:#ffa640">Boost</b>: for 22 seconds you run faster and every jump carries further.</li>
      </ul>
      <h3>Enemies</h3>
      <ul>
        <li><b>Stalkers</b> guard areas and run you down on sight. Outrun them or climb where they cannot follow.</li>
        <li><b>Sentinels</b> sweep a searchlight and fire slow energy shots. Keep cover between you and them.</li>
        <li><b>Drones</b> fly after you, even vertically. Hide behind structures until they give up.</li>
        <li>Enemies only chase what they can <i>see</i>. Break line of sight and they search, then return to their post.</li>
      </ul>
      <h3>The Warden</h3>
      <ul>
        <li>The beacon on the Spire is a door. Reach it and the whole team is pulled through into the storm, where the Warden guards the way on: a four-legged war machine that launches bots.</li>
        <li>Pick one power with <kbd>1</kbd>-<kbd>6</kbd> before it wakes, and use it with the <kbd>Left mouse</kbd> button. Everything you could do on the course still works: sprint, slide, dash, grapple the anchors, ride the zip lines, climb onto its back.</li>
        <li><b>Kinetic Force</b> makes you bigger and tougher: a combo of punches (jab, cross, hook, uppercut), a meteor slam in the air, and <kbd>R</kbd> to tear up debris and hurl it · <b>Telekinesis</b> grabs and throws bots, canisters, plates and its own shells · <b>Lightning</b> chains bolts while held · <b>Gravity</b> throws a crushing well and lets you float · <b>Super Speed</b> runs half again as fast and flash-strikes through everything in a line, again and again · <b>Duplication</b> splits off up to four clones that fight beside you (with four out, a click sends them all at your target).</li>
        <li>Its core on its back and its eye while it charges the beam take more damage. Break its poise and it staggers; charge it into a conductor pillar and it crashes. Down to half and it goes into overdrive.</li>
        <li>Health comes back slowly, and going down is final: you watch your team, and if everyone is down the fight is lost and starts over.</li>
      </ul>
      <h3>Routes</h3>
      <p>Three main routes split and rejoin. The safer-looking one may be much longer; the fast one may have brutal jumps or open sightlines. Teammates can split up — anyone who dies keeps watching the others.</p>`;
  }

  howTo(back: () => void) {
    const s = this.show(`<div class="panel">${this.howToHtml()}<div class="row end panel-foot"><button class="btn small primary" data-a="back">Back <kbd>Esc</kbd></button></div></div>`, 'screen center', back);
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
      <p class="hint quality-note">Graphics quality applies after reloading the page.</p>`;
  }

  /** `canReload`: outside a run, a changed quality preset can be applied on the spot. */
  private bindSettings(root: HTMLElement, canReload = false) {
    const s = this.settings;
    const q = root.querySelector<HTMLSelectElement>('#q')!;
    const running = s.quality;
    q.value = s.quality;
    const note = root.querySelector<HTMLElement>('.quality-note')!;
    const showReload = () => {
      if (!canReload) return;
      note.innerHTML = q.value === running ? 'Graphics quality applies after reloading the page.'
        : 'The new graphics quality needs a reload. <button class="btn small" data-a="reload">Reload now</button>';
      note.querySelector('[data-a=reload]')?.addEventListener('click', () => location.reload());
    };
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
    q.addEventListener('change', () => { s.quality = q.value as Settings['quality']; this.h.settingsChanged(s); showReload(); });
  }

  settingsMenu(back: () => void) {
    const s = this.show(`<div class="panel">${this.settingsHtml()}<div class="row end panel-foot"><button class="btn small primary" data-a="back">Back <kbd>Esc</kbd></button></div></div>`, 'screen center', back);
    this.bindSettings(s, true);
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
      const tag = v.offline ? '' : !p.connected ? '<span class="tag bad">Disconnected</span>' : p.host ? '<span class="tag warn">Host</span>' : p.ready ? '<span class="tag ok">Ready</span>' : '<span class="tag">Not ready</span>';
      const meta = v.offline ? 'Solo run' : `Player ${p.id} · ${p.connected ? 'Connected' : 'Connection lost'}`;
      slots.push(`<div class="slot"><span class="dot" style="background:${PLAYER_CSS[(p.id - 1) % 3]}"></span><div><div class="name">${esc(p.name)}${p.id === v.meId ? ' <span class="hint">(you)</span>' : ''}</div><div class="meta">${meta}</div></div>${tag}</div>`);
    }
    const best = loadBest();
    const bestLine = !best ? 'No runs yet. Reach the beacon on the Spire.'
      : best.time !== undefined ? `Your record: ${fmtTime(best.time)} to the Spire.`
        : `Your best: ${Math.round(best.progress * 100)}% of the way${best.area ? `, to ${esc(best.area)}` : ''}.`;
    const hint = v.offline ? `${bestLine} Use Play on the main menu to host an online game for friends.` : isHost
      ? (others.length === 0 ? 'You can start solo, or share the code so friends can join (up to 3 players).' : allReady ? 'Everyone is ready.' : 'Waiting for players to ready up…')
      : 'Waiting for the host to start the run.';
    const s = this.show(`<div class="panel">
      <h2>Lobby</h2>
      ${v.offline ? '<p class="hint">Offline solo run: the whole course runs in your browser.</p>' : `<div class="code-box"><div><small>Room code</small><div class="code">${esc(v.code)}</div></div><button class="btn small" data-a="copy">Copy</button></div>`}
      <div class="slots">${slots.join('')}</div>
      <p class="hint">${hint}</p>
      <div class="row between" style="margin-top:12px">
        <button class="btn small danger" data-a="leave">Leave</button>
        <div class="row">
          ${!isHost ? `<button class="btn small ${me?.ready ? '' : 'primary'}" data-a="ready">${me?.ready ? 'Not ready' : 'Ready'}</button>` : ''}
          ${isHost && reachedWarden() ? `<button class="btn small" data-a="boss" ${allReady ? '' : 'disabled'} title="Skip the course: the fight with the Warden">Straight to the Warden</button>` : ''}
          ${isHost ? `<button class="btn primary center" data-a="start" ${allReady ? '' : 'disabled'}>Start run</button>` : ''}
        </div>
      </div>
      <details style="margin-top:16px"><summary class="hint" style="cursor:pointer">Controls</summary>${CONTROLS}</details>
    </div>`, 'screen center');
    s.querySelector('[data-a=leave]')!.addEventListener('click', () => this.h.leave());
    s.querySelector('[data-a=ready]')?.addEventListener('click', () => this.h.ready(!me?.ready));
    s.querySelector('[data-a=start]')?.addEventListener('click', () => this.h.start());
    s.querySelector('[data-a=boss]')?.addEventListener('click', () => this.h.startBoss());
    // Enter or Space starts the run straight away
    const startBtn = s.querySelector<HTMLButtonElement>('[data-a=start]:not([disabled])');
    if (startBtn && (document.activeElement === document.body || !document.activeElement)) startBtn.focus();
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
    const box = this.hud.querySelector<HTMLElement>('.hud-players')!;
    // on your own the roster is just your name saying you are alive: leave the corner clear
    box.classList.toggle('hidden', list.length < 2);
    box.classList.toggle('arena', list.some((p) => p.hp !== undefined));
    box.innerHTML = list.map((p) => {
      const st = !p.connected && p.status === Status.Alive ? ['lost', 'Reconnecting'] : p.status === Status.Alive ? ['alive', 'Alive'] : p.status === Status.Dead ? ['dead', 'Dead'] : p.status === Status.Finished ? ['finished', 'Escaped'] : ['left', 'Left'];
      const arena = p.hp !== undefined;
      const pw = arena && p.power !== undefined && p.power >= 0 ? POWER_INFO[SUPERS[p.power]] : null;
      const hp = arena ? `<i class="hp"><i style="width:${Math.max(0, Math.min(100, p.hp!))}%;${p.hp! < 35 ? 'background:var(--danger)' : ''}"></i></i>` : '';
      const label = arena && p.status === Status.Dead ? ['dead', 'Down'] : arena && p.status === Status.Finished ? ['finished', 'Won'] : st;
      return `<div class="hud-player ${p.me ? 'me' : ''}" style="border-left-color:${PLAYER_CSS[(p.id - 1) % 3]}"><span class="n">${esc(p.name)}</span>${pw ? `<b class="s" style="color:${pw.color}">${esc(pw.name)}</b>` : ''}${hp}<span class="s ${label[0]}">${label[1]}</span></div>`;
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

  /**
   * A first-time tip next to a new kind of obstacle. The objective line is a
   * short uppercase banner; tips are full sentences, so they get their own
   * sentence-case card with a dark backing that reads over bright sky, and the
   * lead-in before a colon ("Grapple:") as its label.
   */
  tip(text: string, seconds = 8) {
    const box = this.hud.querySelector<HTMLElement>('.hud-tip')!;
    const m = /^([^:]{2,24}):\s*(.*)$/.exec(text);
    box.innerHTML = m ? `<b>${esc(m[1])}</b>${esc(m[2].charAt(0).toUpperCase() + m[2].slice(1))}` : esc(text);
    box.classList.remove('hidden', 'out');
    void box.offsetWidth;
    box.classList.add('in');
    window.clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => { box.classList.remove('in'); box.classList.add('out'); }, seconds * 1000);
  }

  clearTip() {
    window.clearTimeout(this.tipTimer);
    this.hud.querySelector<HTMLElement>('.hud-tip')!.classList.add('hidden');
  }

  /**
   * Where the runner is and how far along the course, under the timer. The name
   * flares on entering a new area and then settles to a glanceable label, so it
   * marks the moment without becoming another thing flashing mid-run.
   */
  area(name: string | null, progress: number) {
    const box = this.hud.querySelector<HTMLElement>('.hud-area')!;
    const label = box.querySelector<HTMLElement>('.area-name')!;
    box.querySelector<HTMLElement>('.area-bar > b')!.style.width = `${(Math.max(0, Math.min(1, progress)) * 100).toFixed(1)}%`;
    if (name === null) { box.classList.add('hidden'); label.textContent = ''; return; }
    box.classList.remove('hidden');
    if (label.textContent === name) return;
    label.textContent = name;
    // restart the flare animation even when the class is already there
    label.classList.remove('flare');
    void label.offsetWidth;
    label.classList.add('flare');
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

  /**
   * Grapple reticle at screen position (x, y) in pixels, or hidden. `edge` means
   * the anchor itself is off-screen and the marker has been pulled to the border,
   * so it still points at a hook you can fire without looking straight at it.
   */
  reticle(x: number | null, y = 0, hooked = false, edge = false) {
    const r = this.hud.querySelector<HTMLElement>('.hud-reticle')!;
    if (x === null) { r.classList.add('hidden'); return; }
    r.classList.remove('hidden');
    r.classList.toggle('hooked', hooked);
    r.classList.toggle('edge', edge);
    r.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
  }

  // ------------------------------------------------------------------ the portal and Viktor

  /**
   * Fades the screen to (or from) white light. `to` is the target opacity, over
   * `seconds`; the colour warms toward gold for the blessing.
   */
  whiteout(to: number, seconds: number, warm = false, tone: '' | 'storm' = '') {
    const f = this.fade;
    f.classList.toggle('warm', warm);
    f.classList.toggle('storm', tone === 'storm');
    f.style.transition = `opacity ${seconds}s ${to > 0 ? 'ease-in' : 'ease-out'}`;
    void f.offsetWidth;
    f.style.opacity = String(to);
  }

  /** The HUD's element (the arena lays its own HUD into it). */
  get hudRoot(): HTMLElement { return this.hud; }

  /** In the Warden's arena: the fight's HUD takes over parts of the run's. */
  arenaHud(on: boolean) { this.hud.classList.toggle('arena', on); this.hud.querySelector('.crosshair')?.classList.toggle('arena', on); }

  /** In the white room the HUD's light-on-dark text turns dark-on-light. */
  heavenHud(on: boolean) { this.hud.classList.toggle('heaven', on); }

  /** Cinematic bars in (true) or out; the run's HUD steps back while they are in. */
  cinema(on: boolean) {
    this.hud.querySelector('.hud-cine')!.classList.toggle('on', on);
    this.hud.classList.toggle('cine', on);
  }

  /** "E  Talk to Viktor", pinned over his head at screen (x, y), or hidden. */
  interact(x: number | null, y = 0, label = '') {
    const b = this.hud.querySelector<HTMLElement>('.hud-interact')!;
    if (x === null) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    const sp = b.querySelector('span')!;
    if (sp.textContent !== label) sp.textContent = label;
    b.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
  }

  /** The dialogue panel (null hides it). */
  dialogue(d: DialogueView | null) {
    const box = this.hud.querySelector<HTMLElement>('.hud-dialogue')!;
    if (!d) { box.classList.add('hidden'); box.dataset.key = ''; return; }
    const key = `${d.line}|${d.shown}|${d.waiting}`;
    if (box.dataset.key === key) return;
    const wasHidden = box.classList.contains('hidden');
    box.dataset.key = key;
    box.classList.remove('hidden');
    if (wasHidden) { box.classList.remove('in'); void box.offsetWidth; box.classList.add('in'); }
    box.querySelector('.dlg-name')!.textContent = d.name;
    const text = box.querySelector<HTMLElement>('.dlg-text')!;
    // the rest of the line is laid out but invisible, so the text never reflows as it types
    text.innerHTML = `${esc(d.text.slice(0, d.shown))}<span class="dlg-rest">${esc(d.text.slice(d.shown))}</span>`;
    box.querySelector('.dlg-dots')!.innerHTML = Array.from({ length: d.lines }, (_, i) => `<i class="${i < d.line ? 'done' : i === d.line ? 'now' : ''}"></i>`).join('');
    box.classList.toggle('waiting', d.waiting);
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

  pause(isHost: boolean, offline: boolean, solo = false, arena = false) {
    this.closeOverlay();
    const o = el(`<div class="screen center interactive"><div class="panel" style="width:min(380px,92vw)">
      <h2>Paused</h2>
      ${offline ? '' : '<p class="hint">The world keeps moving while you are in this menu.</p>'}
      <div class="menu" style="width:100%">
        <button class="btn primary" data-a="resume">Resume</button>
        ${isHost && solo ? `<button class="btn" data-a="restart">${arena ? 'Restart the fight' : 'Restart run'}</button>` : ''}
        <button class="btn" data-a="settings">Settings</button>
        <button class="btn" data-a="how">How to play</button>
        ${isHost ? `<button class="btn" data-a="lobby">${solo ? 'Back to lobby' : 'Return everyone to lobby'}</button>` : ''}
        <button class="btn danger" data-a="leave">Leave game</button>
      </div></div></div>`);
    this.root.appendChild(o);
    this.overlay = o;
    const panel = o.querySelector('.panel')!;
    const back = () => this.pause(isHost, offline, solo, arena);
    o.querySelector('[data-a=restart]')?.addEventListener('click', () => this.h.restart());
    o.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) this.h.click(); });
    o.querySelector('[data-a=resume]')!.addEventListener('click', () => this.h.resume());
    o.querySelector('[data-a=settings]')!.addEventListener('click', () => {
      panel.innerHTML = `${this.settingsHtml()}<div class="row end panel-foot"><button class="btn small primary" data-a="back">Back</button></div>`;
      this.bindSettings(panel as HTMLElement);
      panel.querySelector('[data-a=back]')!.addEventListener('click', back);
    });
    o.querySelector('[data-a=how]')!.addEventListener('click', () => {
      panel.innerHTML = `${this.howToHtml()}<div class="row end panel-foot"><button class="btn small primary" data-a="back">Back</button></div>`;
      panel.querySelector('[data-a=back]')!.addEventListener('click', back);
    });
    o.querySelector('[data-a=lobby]')?.addEventListener('click', () => this.h.toLobby());
    o.querySelector('[data-a=leave]')!.addEventListener('click', () => this.h.leave());
  }

  closePause() { this.closeOverlay(); }

  results(results: MatchResult[], meId: number, isHost: boolean, duration: number, run?: RunSummary, fight?: FightSummary) {
    if (fight) { this.fightResults(results, meId, isHost, fight, run); return; }
    this.closeOverlay();
    const me = results.find((r) => r.id === meId);
    const escaped = results.filter((r) => r.status === Status.Finished).length;
    const solo = results.length === 1;
    const title = me?.status === Status.Finished ? 'You escaped' : solo ? deathHeadline(me?.cause) : escaped > 0 ? 'The team made it' : 'Nobody escaped';
    const rows = results.map((r) => {
      const status = r.status === Status.Finished ? `<span class="s finished">Escaped${r.place ? ` · #${r.place}` : ''}</span>`
        : r.status === Status.Dead ? `<span class="s dead">${causeText(r.cause)}</span>` : '<span class="s left">Left</span>';
      return `<tr><td><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PLAYER_CSS[(r.id - 1) % 3]};margin-right:10px"></span>${esc(r.name)}</td><td>${status}</td><td class="r">${fmtTime(r.time)}</td></tr>`;
    }).join('');
    const o = el(`<div class="screen center interactive"><div class="panel results-panel">
      <h2>${title}</h2>
      ${run ? runCard(run, solo) : ''}
      ${solo && run ? '' : `<table class="results">${rows}</table>`}
      ${solo && run ? '' : `<p class="hint">Run length ${fmtTime(duration)}. ${isHost ? '' : 'Waiting for the host to start another run…'}</p>`}
      <div class="row between"><button class="btn small danger" data-a="leave">Leave</button>${isHost
        ? `<span class="row"><button class="btn small" data-a="lobby">${solo ? 'Lobby' : 'Back to lobby'}</button><button class="btn primary" data-a="again">Run it again <kbd>R</kbd></button></span>`
        : ''}</div>
    </div></div>`);
    this.root.appendChild(o);
    this.overlay = o;
    o.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) this.h.click(); });
    o.querySelector('[data-a=leave]')!.addEventListener('click', () => this.h.leave());
    o.querySelector('[data-a=lobby]')?.addEventListener('click', () => this.h.toLobby());
    o.querySelector('[data-a=again]')?.addEventListener('click', () => this.h.start());
    o.querySelector<HTMLButtonElement>('[data-a=again]')?.focus();
  }

  /** The Warden is down: the fight's numbers, everyone's share, and a rematch. */
  private fightResults(results: MatchResult[], meId: number, isHost: boolean, f: FightSummary, run?: RunSummary) {
    this.closeOverlay();
    const me = results.find((r) => r.id === meId);
    const solo = results.length === 1;
    const total = results.reduce((a, r) => a + (r.damage ?? 0), 0) || 1;
    const rows = results.map((r) => {
      const pw = r.power !== undefined && r.power >= 0 ? POWER_INFO[SUPERS[r.power]] : null;
      const share = Math.round(((r.damage ?? 0) / total) * 100);
      return `<tr><td><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PLAYER_CSS[(r.id - 1) % 3]};margin-right:10px"></span>${esc(r.name)}${pw ? ` <span class="hint" style="color:${pw.color}">${esc(pw.name)}</span>` : ''}</td>`
        + `<td class="r">${(r.damage ?? 0).toLocaleString()} <span class="hint">${share}%</span></td><td class="r">${r.bots ?? 0} bots</td><td class="r">${r.deaths ?? 0} down</td></tr>`;
    }).join('');
    const best = f.best ? (f.prevBest === null ? '<span class="tag ok">First win</span>' : `<span class="tag ok">New best · was ${fmtTime(f.prevBest)}</span>`)
      : f.prevBest !== null ? `Your best: <b>${fmtTime(f.prevBest)}</b>` : '';
    const stat = (v: string, l: string) => `<div><b>${v}</b><span>${l}</span></div>`;
    const o = el(`<div class="screen center interactive"><div class="panel results-panel">
      <h2>${f.won ? 'The Warden is down' : 'The Warden stands'}</h2>
      <div class="fight-card">
        <div class="fight-title">${esc(me && me.power !== undefined && me.power >= 0 ? POWER_INFO[SUPERS[me.power]].name : 'The fight')}</div>
        <div class="fight-stats">
          ${stat(fmtTime(f.time), f.won ? 'Fight' : 'You lasted')}
          ${me ? stat((me.damage ?? 0).toLocaleString(), 'Damage') : ''}
          ${me ? stat(String(me.bots ?? 0), 'Bots') : ''}
          ${me ? stat(String(me.deaths ?? 0), 'Times down') : ''}
          ${me && me.course ? stat(fmtTime(me.course), 'Course') : ''}
        </div>
        ${best ? `<div class="fight-best">${best}</div>` : ''}
      </div>
      ${run && run.escaped && !run.assisted && run.faster ? `<p class="hint">${run.prevBest?.time !== undefined ? `New course record · was ${fmtTime(run.prevBest.time)}` : 'Your first time through the beacon'}</p>` : ''}
      ${solo ? '' : `<table class="results">${rows}</table>`}
      ${isHost ? '' : '<p class="hint">Waiting for the host…</p>'}
      <div class="row between"><button class="btn small danger" data-a="leave">Leave</button>${isHost
        ? `<span class="row"><button class="btn small" data-a="lobby">Lobby</button><button class="btn small" data-a="again">Run the course</button><button class="btn primary" data-a="boss">${f.won ? 'Fight again' : 'Start over'} <kbd>R</kbd></button></span>`
        : ''}</div>
    </div></div>`);
    this.root.appendChild(o);
    this.overlay = o;
    o.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) this.h.click(); });
    o.querySelector('[data-a=leave]')!.addEventListener('click', () => this.h.leave());
    o.querySelector('[data-a=lobby]')?.addEventListener('click', () => this.h.toLobby());
    o.querySelector('[data-a=again]')?.addEventListener('click', () => this.h.start());
    o.querySelector('[data-a=boss]')?.addEventListener('click', () => this.h.startBoss());
    o.querySelector<HTMLButtonElement>('[data-a=boss]')?.focus();
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

/** Results title for a solo run that ended short of the Spire. */
function deathHeadline(c?: string) {
  switch (c) {
    case 'fall': return 'You fell';
    case 'melee': return 'Caught';
    case 'shot': return 'Shot down';
    case 'flyer': return 'Taken by a drone';
    case 'laser': return 'Lasered';
    default: return 'Run over';
  }
}

/**
 * Where the run ended and how far along the course that is, against the best
 * this browser has managed: a bar with the best marked on it, so a run that
 * got further than ever reads as progress rather than as another death.
 */
function runCard(r: RunSummary, solo: boolean) {
  const pct = Math.round(Math.max(0, Math.min(1, r.progress)) * 100);
  // a solo title already names the cause; with a team it names the outcome, so the card says how you went
  const place = r.area ? `<b>${esc(r.area)}</b>` : 'the open air';
  const where = r.escaped
    ? `Reached the Spire in <b>${fmtTime(r.time)}</b>`
    : solo ? `In ${place}, ${fmtTime(r.time)} into the run` : `${esc(causeText(r.cause))} in ${place} after ${fmtTime(r.time)}`;
  const best = r.prevBest;
  const bestPct = best ? Math.round(best.progress * 100) : null;
  let meta = r.escaped ? 'The whole course' : `${pct}% of the way to the Spire`;
  let badge = '';
  if (best && r.faster && r.escaped) badge = best.time !== undefined ? `<span class="tag ok">New record · was ${fmtTime(best.time)}</span>` : '<span class="tag ok">First escape</span>';
  else if (best && r.further && !r.escaped) badge = `<span class="tag ok">Furthest yet · was ${bestPct}%</span>`;
  // once you have escaped, the thing to beat is the time, not the distance
  else if (best && !r.escaped && best.time !== undefined) meta += ` · your record ${fmtTime(best.time)}`;
  else if (best && !r.escaped) meta += ` · best ${bestPct}%${best.area ? ` (${esc(best.area)})` : ''}`;
  else if (best && r.escaped && best.time !== undefined) meta += ` · record ${fmtTime(best.time)}`;
  if (r.assisted) { meta = r.escaped ? 'Flown with Viktor\'s gift' : `${pct}% of the way, with Viktor's gift`; badge = '<span class="tag">Not counted toward records</span>'; }
  const mark = best && !r.assisted && !r.further && !r.escaped && best.progress < 1 ? `<em style="left:${bestPct}%"></em>` : '';
  return `<div class="run-card">
    <div class="run-where">${where}</div>
    <div class="run-bar"><i style="width:${r.escaped ? 100 : pct}%"></i>${mark}</div>
    <div class="run-meta"><span>${meta}</span>${badge}</div>
  </div>`;
}

export function causeText(c?: string) {
  switch (c) {
    case 'fall': return 'Fell';
    case 'melee': return 'Caught';
    case 'shot': return 'Shot down';
    case 'flyer': return 'Taken by a drone';
    case 'laser': return 'Hit a laser';
    case 'warden': return 'Crushed by the Warden';
    case 'bot': return 'Taken by its bots';
    default: return 'Dead';
  }
}

export function fmtTime(sec: number) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/** Has this browser ever been through the beacon? (The lobby then offers the fight on its own.) */
function reachedWarden() {
  try { return localStorage.getItem('skyfall.warden.v1') === '1'; } catch { return false; }
}

/** A phone or tablet with no mouse or trackpad: the game cannot be controlled there. */
function touchOnly() {
  try { return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches; } catch { return false; }
}

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}
