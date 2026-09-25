// The HUD of the Warden's fight, laid over the run's own HUD (whose timer, area
// name, roster, banners and toasts carry on as they are):
//
//   top centre    the Warden's health: a segmented bar with the chunk just lost
//                 trailing behind it, a tick at the overdrive line, and under it
//                 the poise meter that fills toward a stagger
//   centre        the crosshair in your power's colour, ringed by how ready the
//                 power is (lightning's heat, teleport's charges as pips), a
//                 bracket round whatever it is locked onto, a mark when you land
//                 a hit, a red wedge pointing at whatever just hurt you
//   bottom left   your power and your health
//   world         damage numbers where hits land
//   overlay       the six powers to choose from, when you arrive and while you
//                 are down (a compact row then, with the time until you are back)

import { SUPERS } from '../../shared/constants';
import { POWER_INFO } from '../game/Powers';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A glyph for each power, drawn in its colour. */
export const POWER_ICON: Record<string, string> = {
  kinetic: '<path d="M24 4 L28 18 L42 12 L32 24 L44 32 L29 31 L30 45 L22 34 L12 43 L16 29 L3 25 L17 21 L10 8 L22 17 Z" fill="currentColor"/>',
  telekinesis: '<circle cx="24" cy="24" r="7" fill="currentColor"/><ellipse cx="24" cy="24" rx="19" ry="8" fill="none" stroke="currentColor" stroke-width="3" transform="rotate(-30 24 24)"/><circle cx="39" cy="15" r="3.5" fill="currentColor"/><circle cx="9" cy="33" r="3" fill="currentColor"/>',
  lightning: '<path d="M28 2 L10 27 L22 27 L17 46 L38 18 L26 18 L32 2 Z" fill="currentColor"/>',
  gravity: '<circle cx="24" cy="24" r="6" fill="currentColor"/><path d="M24 6 A18 18 0 0 1 42 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/><path d="M42 24 A18 18 0 0 1 24 42" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.7"/><path d="M24 42 A18 18 0 0 1 6 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity="0.5"/><path d="M6 24 A18 18 0 0 1 24 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.35"/>',
  speed: '<path d="M6 10 L20 24 L6 38 L12 38 L26 24 L12 10 Z M20 10 L34 24 L20 38 L26 38 L40 24 L26 10 Z" fill="currentColor"/><rect x="0" y="22" width="6" height="4" fill="currentColor" opacity="0.6"/>',
  clone: '<circle cx="24" cy="10" r="5.5" fill="currentColor"/><path d="M15 44 L17 24 Q24 18 31 24 L33 44 Z" fill="currentColor"/><circle cx="10" cy="15" r="4" fill="currentColor" opacity="0.55"/><path d="M3 44 L5 28 Q10 23 15 27 L14 44 Z" fill="currentColor" opacity="0.55"/><circle cx="38" cy="15" r="4" fill="currentColor" opacity="0.55"/><path d="M34 44 L33 27 Q38 23 43 28 L45 44 Z" fill="currentColor" opacity="0.55"/>',
};

export interface BossView { name: string; hpK: number; poiseK: number; overdrive: boolean; staggered: boolean; dormant: boolean }
export interface SelectView {
  /** The card that is chosen (or highlighted, if not chosen yet), index into SUPERS. */
  current: number;
  chosen: boolean;
  /** Compact (while down) or full (on arrival). */
  compact: boolean;
  /** A line under the cards. */
  note: string;
}

interface Num { el: HTMLElement; x: number; y: number; z: number; age: number; life: number; drift: number }

export class ArenaHud {
  private readonly root: HTMLElement;
  private readonly boss: HTMLElement;
  private readonly bossFill: HTMLElement;
  private readonly bossTrail: HTMLElement;
  private readonly bossPoise: HTMLElement;
  private readonly bossTag: HTMLElement;
  private readonly me: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly cross: HTMLElement;
  private readonly ringArc: SVGCircleElement;
  private readonly pips: HTMLElement;
  private readonly lockEl: HTMLElement;
  private readonly hitMark: HTMLElement;
  private readonly hurtEl: HTMLElement;
  private readonly select: HTMLElement;
  private readonly nums: Num[] = [];
  private readonly numLayer: HTMLElement;
  private trail = 1;
  private lastHp = 1;
  private selectKey = '';
  private powerKey = '';
  /** Clicking a card (the mouse is free on the selection screen). */
  onPick?: (i: number) => void;

  constructor(hud: HTMLElement) {
    this.root = el(`<div class="arena-hud hidden">
      <div class="boss hidden">
        <div class="boss-head"><span class="boss-name"></span><span class="boss-tag"></span></div>
        <div class="boss-bar"><i class="boss-trail"></i><i class="boss-fill"></i><b class="boss-od"></b><s></s></div>
        <div class="boss-poise"><i></i></div>
      </div>
      <div class="xhair"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="3" class="dot"/><circle cx="32" cy="32" r="22" class="track"/><circle cx="32" cy="32" r="22" class="arc"/></svg><div class="pips"></div></div>
      <div class="lock hidden"><i></i><i></i><i></i><i></i></div>
      <div class="hitmark"></div>
      <div class="hurt"></div>
      <div class="me hidden"><div class="me-icon"></div><div class="me-body"><div class="me-name"></div><div class="me-hp"><i></i><span></span></div></div></div>
      <div class="nums"></div>
      <div class="select hidden interactive"></div>
    </div>`);
    hud.appendChild(this.root);
    const q = <T extends Element = HTMLElement>(s: string) => this.root.querySelector(s) as unknown as T;
    this.boss = q('.boss'); this.bossFill = q('.boss-fill'); this.bossTrail = q('.boss-trail'); this.bossPoise = q('.boss-poise > i'); this.bossTag = q('.boss-tag');
    this.me = q('.me'); this.hpFill = q('.me-hp > i'); this.hpText = q('.me-hp > span');
    this.cross = q('.xhair'); this.ringArc = q<SVGCircleElement>('.xhair .arc'); this.pips = q('.pips');
    this.lockEl = q('.lock'); this.hitMark = q('.hitmark'); this.hurtEl = q('.hurt');
    this.select = q('.select'); this.numLayer = q('.nums');
    this.select.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest('[data-k]') as HTMLElement | null;
      if (card) this.onPick?.(Number(card.dataset.k));
    });
  }

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
    if (!on) { this.selectView(null); this.bossView(null); for (const n of this.nums) n.el.remove(); this.nums.length = 0; }
  }

  // ------------------------------------------------------------------ the Warden

  bossView(b: BossView | null) {
    this.boss.classList.toggle('hidden', !b);
    if (!b) return;
    this.boss.querySelector('.boss-name')!.textContent = b.name;
    this.boss.classList.toggle('od', b.overdrive);
    this.boss.classList.toggle('stag', b.staggered);
    const tag = b.dormant ? 'Dormant' : b.staggered ? 'Staggered' : b.overdrive ? 'Overdrive' : '';
    if (this.bossTag.textContent !== tag) { this.bossTag.textContent = tag; this.bossTag.className = `boss-tag ${tag.toLowerCase()}`; }
    const k = Math.max(0, Math.min(1, b.hpK));
    // the chunk just lost lingers, then drains after it
    if (k < this.lastHp - 0.0005) {
      this.boss.classList.remove('hit');
      void this.boss.offsetWidth;
      this.boss.classList.add('hit');
    }
    this.lastHp = k;
    this.bossFill.style.width = `${(k * 100).toFixed(2)}%`;
    this.bossPoise.style.width = `${(Math.max(0, Math.min(1, b.poiseK)) * 100).toFixed(1)}%`;
  }

  /** Called every frame: the trail behind the health catches up. */
  tick(dt: number) {
    this.trail = this.trail > this.lastHp ? Math.max(this.lastHp, this.trail - dt * 0.25) : this.lastHp;
    this.bossTrail.style.width = `${(this.trail * 100).toFixed(2)}%`;
  }

  // ------------------------------------------------------------------ you

  /** Your power (index into SUPERS, -1 none), health, and the most health you can have. */
  meView(power: number, hp: number, max: number) {
    const has = power >= 0;
    this.me.classList.toggle('hidden', !has);
    this.cross.classList.toggle('hidden', !has);
    if (!has) return;
    const info = POWER_INFO[SUPERS[power]];
    const key = SUPERS[power];
    if (key !== this.powerKey) {
      this.powerKey = key;
      this.me.style.setProperty('--pc', info.color);
      this.cross.style.setProperty('--pc', info.color);
      this.lockEl.style.setProperty('--pc', info.color);
      this.me.querySelector('.me-icon')!.innerHTML = `<svg viewBox="0 0 48 48">${POWER_ICON[key]}</svg>`;
      this.me.querySelector('.me-name')!.textContent = info.name;
    }
    const k = Math.max(0, Math.min(1, hp / max));
    this.hpFill.style.width = `${(k * 100).toFixed(1)}%`;
    this.me.classList.toggle('low', k < 0.34);
    const txt = String(Math.ceil(hp));
    if (this.hpText.textContent !== txt) this.hpText.textContent = txt;
  }

  /** The ring round the crosshair: how ready the power is (0..1), `hot` for lightning's heat, `pips` for charges. */
  ring(ready: number, opts: { hot?: boolean; pips?: [number, number] } = {}) {
    const C = 2 * Math.PI * 22;
    this.ringArc.style.strokeDasharray = `${(C * Math.max(0, Math.min(1, ready))).toFixed(1)} ${C.toFixed(1)}`;
    this.cross.classList.toggle('hot', !!opts.hot);
    this.cross.classList.toggle('ready', ready >= 0.999);
    const pk = opts.pips ? `${opts.pips[0]}/${opts.pips[1]}` : '';
    if (this.pips.dataset.k !== pk) {
      this.pips.dataset.k = pk;
      this.pips.innerHTML = opts.pips ? Array.from({ length: opts.pips[1] }, (_, i) => `<i class="${i < opts.pips![0] ? 'on' : ''}"></i>`).join('') : '';
    }
  }

  /** The bracket round what the crosshair is locked onto (screen px, and a size), or hidden. */
  lock(x: number | null, y = 0, size = 40) {
    if (x === null) { this.lockEl.classList.add('hidden'); return; }
    this.lockEl.classList.remove('hidden');
    const s = Math.max(26, Math.min(140, size));
    this.lockEl.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
    this.lockEl.style.width = this.lockEl.style.height = `${s.toFixed(0)}px`;
  }

  /** A hit of yours landed (crit: on a weak point). */
  hitMarker(crit: boolean) {
    this.hitMark.classList.remove('on', 'crit');
    void this.hitMark.offsetWidth;
    this.hitMark.classList.add('on');
    if (crit) this.hitMark.classList.add('crit');
  }

  /** Something hurt you from `angle` (radians, 0 = straight ahead on screen, clockwise). */
  hurt(angle: number | null, strength: number) {
    const h = this.hurtEl;
    h.style.setProperty('--a', `${angle === null ? 0 : angle}rad`);
    h.classList.toggle('round', angle === null);
    h.style.setProperty('--k', String(Math.max(0.35, Math.min(1, strength))));
    h.classList.remove('on');
    void h.offsetWidth;
    h.classList.add('on');
  }

  // ------------------------------------------------------------------ damage numbers

  /** A number rising from a world point (projected by `update`). */
  number(x: number, y: number, z: number, n: number, cls: '' | 'crit' | 'mine' | 'bot') {
    if (this.nums.length > 28) { const o = this.nums.shift()!; o.el.remove(); }
    const e = el(`<b class="num ${cls}">${n}</b>`);
    this.numLayer.appendChild(e);
    this.nums.push({ el: e, x, y, z, age: 0, life: cls === 'crit' ? 1.1 : 0.85, drift: (Math.random() - 0.5) * 30 });
  }

  /** Moves the numbers: `project` turns a world point into screen px (null when behind the camera). */
  updateNumbers(dt: number, project: (x: number, y: number, z: number) => [number, number] | null) {
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      n.age += dt;
      if (n.age > n.life) { n.el.remove(); this.nums.splice(i, 1); continue; }
      const p = project(n.x, n.y, n.z);
      if (!p) { n.el.style.opacity = '0'; continue; }
      const k = n.age / n.life;
      const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.6 : 1.2 - Math.min(0.2, (k - 0.12) * 0.4);
      n.el.style.opacity = String(k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1);
      n.el.style.transform = `translate(${(p[0] + n.drift * k).toFixed(0)}px, ${(p[1] - 60 * k).toFixed(0)}px) translate(-50%, -50%) scale(${pop.toFixed(2)})`;
    }
  }

  // ------------------------------------------------------------------ choosing a power

  selectView(v: SelectView | null) {
    const key = v ? `${v.current}|${v.chosen}|${v.compact}|${v.note}` : '';
    if (key === this.selectKey) return;
    this.selectKey = key;
    if (!v) { this.select.classList.add('hidden'); return; }
    this.select.classList.remove('hidden');
    this.select.classList.toggle('compact', v.compact);
    const cards = SUPERS.map((k, i) => {
      const info = POWER_INFO[k];
      const on = i === v.current;
      return `<button class="card ${on ? 'on' : ''} ${on && v.chosen ? 'chosen' : ''}" data-k="${i}" style="--pc:${info.color}">
        <kbd>${i + 1}</kbd><svg viewBox="0 0 48 48">${POWER_ICON[k]}</svg>
        <b>${esc(info.name)}</b>${v.compact ? '' : `<em>${esc(info.line)}</em><small>${esc(info.how)}</small>`}
      </button>`;
    }).join('');
    this.select.innerHTML = `${v.compact ? '' : '<h3>Choose your power</h3>'}<div class="cards">${cards}</div><p>${esc(v.note)}</p>`;
  }
}

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}
