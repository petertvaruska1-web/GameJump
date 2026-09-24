// The local runner's superpower: aim, the press, and everything that happens on
// your own screen the moment the button goes down. Nothing waits for the server:
// a punch lunges and a blink moves you there and then, a bolt cracks out, a well
// flies, the effects and sounds play; the server is told what you did ('pow')
// and decides what it hit, and its answers (damage, a chain of bolts, what you
// are holding) arrive a moment later as events and snapshots.
//
// Aim is the centre of the screen with a gentle lock: whatever is closest to the
// crosshair (within a few degrees, in range, in sight) is what a power goes for,
// marked on screen, so a moving target is hit by pointing near it, not at the
// pixel. The cool-downs here mirror the server's, so the HUD tells the truth and
// the button never promises what the server will refuse.

import * as THREE from 'three';
import { POW, PLAYER, SUPERS, type SuperPower } from '../../shared/constants';
import { clamp } from '../../shared/math';
import type { CollisionWorld, RayHit } from '../../shared/physics/world';
import { BPart, JunkKind, PowAct, type C2S } from '../../shared/protocol';
import type { LocalPlayer } from '../player/LocalPlayer';

/** Something the crosshair can lock onto. kind: 0 the Warden (with a part), 1 a bot, 2 a loose thing. */
export interface AimTarget { kind: 0 | 1 | 2; id: number; part: number; pos: THREE.Vector3; r: number; junk?: number }

export interface PowersHost {
  send(m: C2S): void;
  world(): CollisionWorld;
  /** Everything that can be aimed at right now. */
  targets(): AimTarget[];
  /** Where a thing held with telekinesis floats (the runner's own, drawn without lag). */
  holdPoint(out: THREE.Vector3): THREE.Vector3;
  /** Feedback on your own screen. */
  punch(at: THREE.Vector3, dir: THREE.Vector3, hit: boolean): void;
  slam(at: THREE.Vector3, speed: number): void;
  bolt(pts: THREE.Vector3[]): void;
  push(at: THREE.Vector3, dir: THREE.Vector3): void;
  well(from: THREE.Vector3, dir: THREE.Vector3): void;
  flash(from: THREE.Vector3, to: THREE.Vector3): void;
  blink(from: THREE.Vector3, to: THREE.Vector3): void;
  thrown(from: THREE.Vector3, dir: THREE.Vector3): void;
  sound(kind: string, strength?: number): void;
  shake(k: number): void;
  fov(deg: number): void;
  /** The runner's arms (punch, cast, hold, throw). */
  act(kind: 'punch' | 'cast' | 'hold' | 'throw' | 'push'): void;
}

/** The six powers on screen: name, colour and what the button does. */
export const POWER_INFO: Record<SuperPower, { name: string; color: string; hex: number; line: string; how: string }> = {
  kinetic: { name: 'Kinetic Force', color: '#ff9a3c', hex: 0xff9a3c, line: 'Hit like a falling building.', how: 'Click: a lunging punch that sends things flying. In the air: a meteor slam.' },
  telekinesis: { name: 'Telekinesis', color: '#ff5fd2', hex: 0xff5fd2, line: 'Take hold of anything. Throw it.', how: 'Click: grab the bot, canister, plate or shell under the crosshair. Click again: throw it. Nothing to grab: a push that turns shots round.' },
  lightning: { name: 'Lightning', color: '#5ee7ff', hex: 0x5ee7ff, line: 'Faster than anything in the storm.', how: 'Hold: rapid bolts that chain between targets. Watch the heat. Keep pouring it on and the storm answers.' },
  gravity: { name: 'Gravity', color: '#8c6bff', hex: 0x8c6bff, line: 'Make the world fall where you choose.', how: 'Click: throw a well that drags bots in, crushes them and bursts. Your jumps go higher; hold Space to float down.' },
  speed: { name: 'Super Speed', color: '#ffe04a', hex: 0xffe04a, line: 'Everything else is standing still.', how: 'You run faster. Click: a flash strike through everything in your path. A hit chains into the next strike.' },
  teleport: { name: 'Teleport', color: '#4dffa6', hex: 0x4dffa6, line: 'Be somewhere else. Now.', how: 'Click: blink to the crosshair (three charges), ripping space at both ends. Behind it, or onto its back, hurts most.' },
};

const hit: RayHit = { dist: 0, c: null };
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), fwd = new THREE.Vector3(), chest = new THREE.Vector3();

export class Powers {
  kind: SuperPower | null = null;
  // the server's cool-downs, mirrored (match times)
  ready = 0;
  slamReady = 0;
  pushReady = 0;
  boltReady = 0;
  flashReady = 0;
  chain = 0;
  heat = 0;
  overheatUntil = 0;
  charges: number = POW.teleport.CHARGES;
  chargeAt = 0;
  /** What you hold with telekinesis (optimistic until a snapshot says otherwise). */
  held: { kind: 1 | 2; id: number; at: number } | null = null;
  /** What the crosshair is locked onto. */
  lock: AimTarget | null = null;
  /** Where the crosshair points in the world (or 120 m out). */
  readonly aimPoint = new THREE.Vector3();
  private flashV = 0;
  private flashLocked = false;
  private readonly flashDir = new THREE.Vector3();
  private lastMt = 0;

  constructor(private readonly host: PowersHost) {}

  /** A new power (or the same one after coming back): cool-downs reset, passives applied. */
  set(index: number, local: LocalPlayer | null) {
    this.kind = index >= 0 ? SUPERS[index] : null;
    this.ready = this.slamReady = this.pushReady = this.boltReady = this.flashReady = 0;
    this.chain = 0; this.heat = 0; this.overheatUntil = 0; this.charges = POW.teleport.CHARGES; this.chargeAt = 0;
    this.held = null;
    if (local) this.passives(local);
  }

  /** The power's effect on how the runner moves (speed runs faster, gravity jumps higher and floats). */
  passives(local: LocalPlayer) {
    const m = local.motor, k = this.kind;
    m.runScale = k === 'speed' ? POW.speed.RUN : 1;
    m.sprintScale = k === 'speed' ? POW.speed.SPRINT : 1;
    m.accelScale = k === 'speed' ? POW.speed.ACCEL : 1;
    m.jumpScale = k === 'gravity' ? POW.gravity.JUMP : 1;
    m.floaty = k === 'gravity';
  }

  /** Back to a plain runner (leaving the arena). */
  clear(local: LocalPlayer | null) { this.kind = null; this.held = null; this.lock = null; if (local) this.passives(local); }

  /** Heat right now (it cools continuously). */
  heatAt(mt: number) { return Math.max(0, this.heat - POW.lightning.COOL * Math.max(0, mt - this.lastMt)); }

  /** Teleport charges right now, and how far the next one has come back (0..1). */
  chargeState(mt: number): [number, number] {
    let c = this.charges, at = this.chargeAt;
    while (c < POW.teleport.CHARGES && mt >= at) { c++; at += POW.teleport.RECHARGE; }
    return [c, c >= POW.teleport.CHARGES ? 1 : 1 - (at - mt) / POW.teleport.RECHARGE];
  }

  /** How ready the button is, 0..1 (for the HUD ring). */
  readiness(mt: number): number {
    switch (this.kind) {
      case 'kinetic': return clamp(1 - (this.ready - mt) / POW.kinetic.COOLDOWN, 0, 1);
      case 'telekinesis': return this.held ? 1 : clamp(1 - (Math.max(this.ready, this.pushReady) - mt) / POW.telekinesis.PUSH_COOLDOWN, 0, 1);
      case 'lightning': return mt < this.overheatUntil ? 0 : 1 - this.heatAt(mt) / 100;
      case 'gravity': return clamp(1 - (this.ready - mt) / POW.gravity.COOLDOWN, 0, 1);
      case 'speed': return clamp(1 - (this.flashReady - mt) / POW.speed.CHAIN_REST, 0, 1);
      case 'teleport': { const [c, k] = this.chargeState(mt); return c >= 1 ? 1 : k; }
      default: return 0;
    }
  }

  private range(): number {
    switch (this.kind) {
      case 'kinetic': return POW.kinetic.REACH + 3;
      case 'telekinesis': return POW.telekinesis.RANGE;
      case 'lightning': return POW.lightning.RANGE;
      case 'gravity': return POW.gravity.RANGE;
      case 'speed': return POW.speed.DIST - POW.speed.OVERSHOOT;
      default: return POW.teleport.RANGE;
    }
  }

  /**
   * Every frame: aim, and the button. `press` is this frame's click, `hold` the
   * button held down. Runs before the runner's physics steps, so a power that
   * moves you moves you in this very frame.
   */
  update(mt: number, local: LocalPlayer, camera: THREE.Camera, press: boolean, hold: boolean, can: boolean) {
    const k = this.kind;
    // cool lightning's heat, and let go of a grab the server never confirmed
    this.heat = this.heatAt(mt);
    this.lastMt = mt;
    if (this.held && mt - this.held.at > 0.8 && !this.host.targets().some((t) => t.kind === this.held!.kind && t.id === this.held!.id)) this.held = null;
    // aim: the crosshair ray against the world, and the lock
    camera.getWorldDirection(fwd);
    const cam = camera.position;
    const w = this.host.world();
    w.raycast(cam.x, cam.y, cam.z, fwd.x, fwd.y, fwd.z, 120, false, hit);
    this.aimPoint.copy(cam).addScaledVector(fwd, hit.c ? hit.dist : 120);
    const b = local.motor.body;
    chest.set(b.pos.x, b.pos.y + 1.25, b.pos.z);
    this.lock = k ? this.pickLock(cam, fwd, k) : null;
    if (!k || !can || local.dead || local.frozen) return;
    switch (k) {
      case 'kinetic': if (press) this.punch(mt, local); break;
      case 'telekinesis': if (press) this.telekinesis(mt); break;
      case 'lightning': if (hold || press) this.bolt(mt); break;
      case 'gravity': if (press) this.well(mt); break;
      case 'speed': if (press) this.flash(mt, local); break;
      case 'teleport': if (press) this.blink(mt, local); break;
    }
  }

  /** The target nearest the crosshair that this power can reach and see. */
  private pickLock(cam: THREE.Vector3, dir: THREE.Vector3, k: SuperPower): AimTarget | null {
    const range = this.range();
    const cone = k === 'lightning' ? POW.lightning.LOCK : POW.telekinesis.LOCK;
    let best: AimTarget | null = null, bestScore = Infinity;
    const w = this.host.world();
    for (const t of this.host.targets()) {
      if (k === 'telekinesis' && t.kind === 0) continue; // the Warden is too heavy to lift
      if (k === 'telekinesis' && this.held && t.kind === this.held.kind && t.id === this.held.id) continue;
      tmp.subVectors(t.pos, cam);
      const along = tmp.dot(dir);
      if (along <= 0) continue;
      const dist = tmp.length();
      const ang = Math.acos(clamp(along / dist, -1, 1)) - Math.atan(t.r / dist);
      if (ang > cone) continue;
      const reach = chest.distanceTo(t.pos) - t.r;
      if (reach > range) continue;
      // in sight from the chest (the Warden's own body does not hide its parts)
      tmp2.subVectors(t.pos, chest);
      const d = tmp2.length();
      if (d > 0.5) {
        w.raycast(chest.x, chest.y, chest.z, tmp2.x / d, tmp2.y / d, tmp2.z / d, Math.max(0, d - t.r - 0.2), false, hit);
        if (hit.c && !(t.kind === 0 && hit.c.kind === 'puppet')) continue;
      }
      // prefer what is nearest the crosshair; the core and the eye a little more
      const bonus = t.kind === 0 ? (t.part === BPart.Core ? 0.06 : t.part === BPart.Eye ? 0.05 : t.part === BPart.Head ? 0.02 : 0) : t.kind === 2 && t.junk === JunkKind.Canister ? 0.03 : 0.02;
      const score = Math.max(0, ang) - bonus + reach * 0.002;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /** Aim from the chest: at the lock, or at whatever the crosshair points at. */
  private aimFrom(from: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.subVectors(this.lock ? this.lock.pos : this.aimPoint, from);
    const l = out.length();
    return l > 1e-3 ? out.divideScalar(l) : out.copy(fwd);
  }

  private tell(a: number, d: THREE.Vector3, o: { x: number; y: number; z: number }, mt: number, extra: Partial<Extract<C2S, { t: 'pow' }>> = {}) {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    this.host.send({ t: 'pow', a, o: [r(o.x), r(o.y), r(o.z)], d: [r(d.x), r(d.y), r(d.z)], tm: r(mt), ...extra });
  }

  private tg(): [number, number, number] | undefined {
    return this.lock ? [this.lock.kind, this.lock.id, this.lock.part] : undefined;
  }

  // ------------------------------------------------------------------ the six

  private punch(mt: number, local: LocalPlayer) {
    const K = POW.kinetic, m = local.motor, b = m.body;
    if (!m.free) return;
    if (!b.grounded && m.coyote <= 0) {
      // in the air: a meteor slam (the landing is told to the server when it happens)
      if (mt < this.slamReady || m.slamming) return;
      m.startSlam(K.SLAM_SPEED);
      this.host.sound('slamDive');
      this.host.fov(4);
      return;
    }
    if (mt < this.ready) return;
    this.ready = mt + K.COOLDOWN;
    const d = this.aimFrom(chest, tmp);
    const flat = tmp2.set(d.x, 0, d.z);
    if (flat.lengthSq() < 1e-4) flat.set(Math.sin(m.yaw), 0, Math.cos(m.yaw));
    flat.normalize();
    m.startLunge(flat.x, flat.z, K.LUNGE_SPEED, K.LUNGE_TIME);
    d.y = clamp(d.y, -0.5, 0.6);
    this.tell(PowAct.Punch, d, b.pos, mt);
    const fist = chest.clone().addScaledVector(flat, 1.6);
    const reaching = !!this.lock && chest.distanceTo(this.lock.pos) - this.lock.r < K.REACH + 1.6;
    this.host.punch(fist, flat, reaching);
    this.host.act('punch');
    this.host.sound('punch', reaching ? 1 : 0.5);
    this.host.shake(reaching ? 0.22 : 0.08);
    this.host.fov(reaching ? 4 : 2);
  }

  /** A slam landed (from the runner's motor). */
  slamLanded(mt: number, local: LocalPlayer, speed: number) {
    if (this.kind !== 'kinetic') return;
    this.slamReady = mt + POW.kinetic.SLAM_COOLDOWN;
    const b = local.motor.body;
    this.host.send({ t: 'pow', a: PowAct.Slam, o: [b.pos.x, b.pos.y, b.pos.z], d: [0, -1, 0], p: [b.pos.x, b.pos.y, b.pos.z], v: Math.round(speed * 100) / 100, tm: mt });
    this.host.slam(new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z), speed);
    this.host.sound('slam', clamp(speed / POW.kinetic.SLAM_SPEED, 0.5, 1.2));
    this.host.shake(0.55);
    this.host.fov(6);
  }

  private telekinesis(mt: number) {
    const T = POW.telekinesis;
    if (mt < this.ready) return;
    if (this.held) {
      const from = this.host.holdPoint(new THREE.Vector3());
      const d = this.aimFrom(from, tmp);
      this.tell(PowAct.Throw, d, chestFeet(), mt);
      this.host.thrown(from, d.clone());
      this.host.act('throw');
      this.host.sound('throw');
      this.host.shake(0.12);
      this.held = null;
      this.ready = mt + T.THROW_COOLDOWN;
      return;
    }
    const lock = this.lock;
    if (lock && lock.kind !== 0) {
      this.tell(PowAct.Grab, this.aimFrom(chest, tmp), chestFeet(), mt, { tg: this.tg() });
      this.held = { kind: lock.kind as 1 | 2, id: lock.id, at: mt };
      this.ready = mt + T.COOLDOWN;
      this.host.act('hold');
      this.host.sound('grab');
      return;
    }
    if (mt < this.pushReady) return;
    this.pushReady = mt + T.PUSH_COOLDOWN;
    this.ready = mt + T.COOLDOWN;
    const d = this.aimFrom(chest, tmp);
    this.tell(PowAct.Push, d, chestFeet(), mt);
    this.host.push(chest.clone(), d.clone());
    this.host.act('push');
    this.host.sound('push');
    this.host.shake(0.1);
  }

  private bolt(mt: number) {
    const L = POW.lightning;
    if (mt < this.boltReady || mt < this.overheatUntil) return;
    this.boltReady = mt + L.INTERVAL;
    this.heat += L.HEAT_PER;
    if (this.heat >= 100) { this.heat = 0; this.overheatUntil = mt + L.OVERHEAT; this.host.sound('overheat'); }
    const d = this.aimFrom(chest, tmp);
    this.tell(PowAct.Bolt, d, chestFeet(), mt, { tg: this.tg() });
    const hand = chest.clone().add(tmp2.set(d.z, 0, -d.x).multiplyScalar(0.3)).addScaledVector(d, 0.4);
    let end: THREE.Vector3;
    if (this.lock) end = this.lock.pos.clone();
    else {
      this.host.world().raycast(chest.x, chest.y, chest.z, d.x, d.y, d.z, L.RANGE, false, hit);
      end = chest.clone().addScaledVector(d, hit.c ? hit.dist : L.RANGE);
    }
    this.host.bolt([hand, end]);
    this.host.act('cast');
    this.host.sound('bolt');
    this.host.shake(0.04);
  }

  private well(mt: number) {
    if (mt < this.ready) return;
    this.ready = mt + POW.gravity.COOLDOWN;
    const d = this.aimFrom(chest, tmp);
    this.tell(PowAct.Well, d, chestFeet(), mt);
    this.host.well(chest.clone().addScaledVector(d, 1.2), d.clone());
    this.host.act('cast');
    this.host.sound('wellThrow');
    this.host.shake(0.08);
  }

  private flash(mt: number, local: LocalPlayer) {
    const S = POW.speed, m = local.motor, b = m.body;
    if (mt < this.flashReady || !m.free) return;
    const d = this.aimFrom(chest, tmp);
    // no steeper than PITCH up or down
    const hl = Math.hypot(d.x, d.z) || 1, p = clamp(Math.atan2(d.y, hl), -S.PITCH, S.PITCH);
    d.set((d.x / hl) * Math.cos(p), Math.sin(p), (d.z / hl) * Math.cos(p));
    let dist = S.DIST;
    this.flashLocked = !!this.lock;
    if (this.lock) dist = Math.min(S.DIST, chest.distanceTo(this.lock.pos) + S.OVERSHOOT);
    this.flashV = Math.hypot(b.vel.x, b.vel.z);
    this.flashDir.copy(d);
    m.startFlash(d.x, d.y, d.z, dist, S.FLASH_SPEED);
    // the chain: a strike that finds something is ready again almost at once
    if (this.flashLocked) {
      this.chain++;
      this.flashReady = mt + (this.chain >= S.CHAIN_MAX ? S.CHAIN_REST : S.CHAIN_COOLDOWN);
      if (this.chain >= S.CHAIN_MAX) this.chain = 0;
    } else { this.chain = 0; this.flashReady = mt + S.COOLDOWN; }
    this.host.sound('flash');
    this.host.fov(8);
    this.host.shake(0.12);
  }

  /** The streak ended (from the runner's motor): now the server hears where it went. */
  flashEnded(mt: number, local: LocalPlayer, from: { x: number; y: number; z: number }) {
    if (this.kind !== 'speed') return;
    const b = local.motor.body;
    const d = this.flashDir;
    this.host.send({ t: 'pow', a: PowAct.Flash, o: [from.x, from.y, from.z], d: [d.x, d.y, d.z], p: [b.pos.x, b.pos.y, b.pos.z], v: Math.round(this.flashV * 100) / 100, tm: mt });
    this.host.flash(new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z));
    if (this.flashLocked) this.host.shake(0.2);
  }

  private blink(mt: number, local: LocalPlayer) {
    const B = POW.teleport, m = local.motor, b = m.body;
    const [c] = this.chargeState(mt);
    if (c < 1 || m.flashing) return;
    // spend a charge (a full set starts recharging now)
    this.charges = c - 1;
    if (c >= B.CHARGES) this.chargeAt = mt + B.RECHARGE;
    else { let at = this.chargeAt; while (at <= mt) at += B.RECHARGE; this.chargeAt = at; }
    const w = this.host.world();
    const d = this.aimFrom(chest, tmp);
    w.raycast(chest.x, chest.y, chest.z, d.x, d.y, d.z, B.RANGE, false, hit);
    const reach = hit.c ? Math.max(0.5, hit.dist - 0.6) : B.RANGE;
    const dest = chest.clone().addScaledVector(d, reach);
    dest.y -= 1.25;
    // come down on whatever is just below (a floor, a roof, the Warden's back)
    const below = w.groundBelow(dest.x, dest.y + 1.2, dest.z, 3);
    if (isFinite(below)) dest.y = dest.y + 1.2 - below;
    // never inside anything: back off along the way you came until there is room
    for (let i = 0; i < 12 && !w.isSpaceFree(dest.x, dest.y + 0.05, dest.z, PLAYER.RADIUS, PLAYER.HEIGHT); i++) {
      dest.addScaledVector(d, -0.5);
      if (i === 5) dest.y += 0.8;
    }
    const from = new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z);
    local.blink(dest.x, dest.y, dest.z);
    this.host.send({ t: 'pow', a: PowAct.Blink, o: [from.x, from.y, from.z], d: [d.x, d.y, d.z], p: [dest.x, dest.y, dest.z], tm: mt });
    this.host.blink(from, dest);
    this.host.sound('blink');
    this.host.fov(6);
    this.host.shake(0.1);
  }
}

/** The runner's feet (what 'pow' messages say they are from); filled by the arena each frame. */
const feet = new THREE.Vector3();
function chestFeet() { return feet.set(chest.x, chest.y - 1.25, chest.z); }
