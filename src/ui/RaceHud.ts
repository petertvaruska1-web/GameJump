// Speedster Battle's HUD, laid into the run's HUD while racing:
//
//   top centre      your place ("2nd / 3"), and under it the course as a strip with
//                   its sections ticked off and a dot for every runner in its colour
//   bottom centre   the speedometer: an arc in your colour filling toward the top
//                   speed, a mark where your cadence is driving you, the speed in
//                   km/h, and the mouse's two buttons either side of it: each flashes
//                   as a stride of it counts, the one to click next breathes, and a
//                   click on the same button again flashes red (it does not count)
//
// Everything is fixed-size (tabular numbers, fixed slots) so nothing shifts as the
// numbers change; it all reads from the race each frame.

import { RACE } from '../../shared/constants';
import { PLAYER_CSS } from '../render/CharacterModel';

/** The dial: a half circle over the speed, centre (110, 118), radius 88, left to right over the top. */
const ARC = 'M 22 118 A 88 88 0 1 1 198 118';

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

const MOUSE = (side: 'l' | 'r') => `<svg viewBox="0 0 40 56" class="rh-mouse ${side}">
  <rect x="3" y="3" width="34" height="50" rx="17" class="body"/>
  <path d="M 20 3 A 17 17 0 0 0 3 20 L 3 24 L 20 24 Z" class="btn b-l"/>
  <path d="M 20 3 A 17 17 0 0 1 37 20 L 37 24 L 20 24 Z" class="btn b-r"/>
  <line x1="20" y1="3" x2="20" y2="24" class="seam"/>
</svg>`;

export interface RaceHudView {
  speed: number;
  /** The speed the cadence drives toward. */
  target: number;
  cadence: number;
  /** The button to click next (0 left, 1 right; -1 either). */
  next: number;
  place: number;
  runners: number;
  /** Each runner's share of the course (0..1) and its id; which one is you. */
  dots: { id: number; k: number; me: boolean; home: boolean }[];
  /** Before "Go!": the speedometer waits. */
  waiting: boolean;
}

export class RaceHud {
  private readonly root: HTMLElement;
  private readonly kmh: HTMLElement;
  private readonly cad: HTMLElement;
  private readonly fill: SVGPathElement;
  private readonly tgt: SVGLineElement;
  private readonly mice: [SVGElement, SVGElement];
  private readonly placeEl: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly dots = new Map<number, HTMLElement>();
  private readonly speedo: HTMLElement;
  private lastKmh = -1;
  private lastCad = '';
  private lastPlace = '-';

  constructor(hud: HTMLElement, sections: { s0: number; s1: number; name: string }[], start: number, finish: number) {
    const ticks = sections.slice(1).map((s) => {
      const k = Math.max(0, Math.min(1, (s.s0 - start) / (finish - start)));
      return `<i class="rh-tick" style="left:${(k * 100).toFixed(2)}%" title="${s.name}"></i>`;
    }).join('');
    this.root = el(`<div class="race-hud hidden">
      <div class="rh-top">
        <div class="rh-place"><b>1</b><sup>st</sup><span></span></div>
        <div class="rh-strip"><i class="rh-line"></i>${ticks}<i class="rh-flag"></i></div>
      </div>
      <div class="rh-speedo">
        <svg viewBox="0 0 220 132" class="rh-gauge">
          <path d="${ARC}" class="track" pathLength="1"/>
          <path d="${ARC}" class="fill" pathLength="1"/>
          <line x1="110" y1="12" x2="110" y2="26" class="tgt"/>
        </svg>
        <div class="rh-kmh"><b>0</b><span>km/h</span></div>
        <div class="rh-cad"><b>0.0</b> strides/s</div>
        ${MOUSE('l')}${MOUSE('r')}
      </div>
    </div>`);
    hud.appendChild(this.root);
    const q = <T extends Element = HTMLElement>(s: string) => this.root.querySelector(s) as unknown as T;
    this.kmh = q('.rh-kmh b'); this.cad = q('.rh-cad b');
    this.fill = q<SVGPathElement>('.fill'); this.tgt = q<SVGLineElement>('.tgt');
    this.mice = [q<SVGElement>('.rh-mouse.l'), q<SVGElement>('.rh-mouse.r')];
    this.placeEl = q('.rh-place'); this.strip = q('.rh-strip'); this.speedo = q('.rh-speedo');
  }

  show(on: boolean, color?: string) {
    this.root.classList.toggle('hidden', !on);
    if (color) this.root.style.setProperty('--pc', color);
    if (!on) { for (const d of this.dots.values()) d.remove(); this.dots.clear(); this.lastKmh = -1; this.lastPlace = '-'; }
  }

  /** A stride of this button counted (0 left, 1 right). */
  stride(b: number) { this.flash(this.mice[b], 'hit'); }
  /** The same button again: it did not count. */
  miss(b: number) { this.flash(this.mice[b], 'miss'); }

  private flash(e: SVGElement, cls: string) {
    e.classList.remove('hit', 'miss');
    void (e as unknown as HTMLElement).getBoundingClientRect();
    e.classList.add(cls);
  }

  update(v: RaceHudView) {
    const kmh = Math.round(v.speed * 3.6);
    if (kmh !== this.lastKmh) { this.lastKmh = kmh; this.kmh.textContent = String(kmh); }
    const cad = v.cadence.toFixed(1);
    if (cad !== this.lastCad) { this.lastCad = cad; this.cad.textContent = cad; }
    const k = Math.max(0, Math.min(1, v.speed / RACE.TOP));
    this.fill.style.strokeDasharray = `${k.toFixed(4)} 1`;
    // where the cadence is taking you: a mark across the dial
    const t = Math.max(0, Math.min(1, v.target / RACE.TOP));
    const ang = Math.PI * (1 + t);
    const ox = 110 + Math.cos(ang) * 74, oy = 118 + Math.sin(ang) * 74, ex = 110 + Math.cos(ang) * 101, ey = 118 + Math.sin(ang) * 101;
    this.tgt.setAttribute('x1', ox.toFixed(1)); this.tgt.setAttribute('y1', oy.toFixed(1));
    this.tgt.setAttribute('x2', ex.toFixed(1)); this.tgt.setAttribute('y2', ey.toFixed(1));
    this.speedo.classList.toggle('max', k > 0.96);
    this.speedo.classList.toggle('waiting', v.waiting);
    this.mice[0].classList.toggle('next', v.next === 0 || v.next === -1);
    this.mice[1].classList.toggle('next', v.next === 1 || v.next === -1);
    // your place
    const place = v.runners > 1 ? `${v.place}|${v.runners}` : '';
    if (place !== this.lastPlace) {
      this.lastPlace = place;
      this.placeEl.classList.toggle('hidden', v.runners < 2);
      const sfx = ['th', 'st', 'nd', 'rd'][v.place] ?? 'th';
      this.placeEl.innerHTML = `<b>${v.place}</b><sup>${sfx}</sup><span>/ ${v.runners}</span>`;
    }
    // everyone along the strip
    const seen = new Set<number>();
    for (const d of v.dots) {
      seen.add(d.id);
      let e = this.dots.get(d.id);
      if (!e) {
        e = el(`<b class="rh-dot${d.me ? ' me' : ''}" style="--dc:${PLAYER_CSS[(d.id - 1) % 3]}"></b>`);
        this.strip.appendChild(e);
        this.dots.set(d.id, e);
      }
      e.style.left = `${(Math.max(0, Math.min(1, d.k)) * 100).toFixed(2)}%`;
      e.classList.toggle('home', d.home);
    }
    for (const [id, e] of this.dots) if (!seen.has(id)) { e.remove(); this.dots.delete(id); }
  }
}
