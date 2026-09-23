// The portal easter egg on the client. On the course: the portal itself, its
// music carrying across the ruins, and walking into it. Through it: the white
// room, Viktor, his speech and his blessing. Back out: the landing pad, and the
// gift of flight for the rest of the run.
//
// The server decides everything that matters (whether this run has a portal,
// that you really went through, that you were sent back able to fly); this
// class only ever asks it ('portal', 'bless') and plays out what it answers.
//
//   off --walk into the ring--> enter --server agrees--> room --E at Viktor--> talk
//   talk --last line--> bless --white--> leave --server sends you back--> off

import * as THREE from 'three';
import { PORTAL } from '../../shared/constants';
import { clamp, damp, lerp, smoothstep } from '../../shared/math';
import { Anim } from '../../shared/physics/character';
import type { AudioEngine } from '../audio/Audio';
import type { CameraController } from '../player/CameraController';
import type { LocalPlayer } from '../player/LocalPlayer';
import { DOOR_BEHIND, HeavenView, HEAVEN_RADIUS } from '../render/HeavenView';
import { PortalView } from '../render/PortalView';
import type { ViktorGesture } from '../render/ViktorModel';
import { FLIGHT_TIP, type UI } from '../ui/UI';

/** Viktor's words, one box at a time, and what his hands do with each (`then`: a change partway through). */
export const VIKTOR_LINES: { text: string; gesture: ViktorGesture; then?: { from: string; gesture: ViktorGesture } }[] = [
  { text: 'You are one of many trying to beat this game, get to the other side.', gesture: 'open' },
  { text: 'I know how it feels like, I have done this before,', gesture: 'chest' },
  { text: 'I was the first one to stand upon the beacon, the one who tamed this game for the first time in history.', gesture: 'point' },
  { text: 'You were going to suffer trying to get to reach it, but not anymore, get out there, my child, for the beacon is yours to command.', gesture: 'palms', then: { from: 'get out there', gesture: 'bless' } },
];

/** Typing speed (characters a second) and the pauses a comma and a full stop leave. */
const CPS = 32;
const PAUSE_COMMA = 0.26;
const PAUSE_STOP = 0.5;
/** How close you have to be to talk to him, and when he waves. */
const TALK_RANGE = 3.4;
const WAVE_RANGE = 11;
/** Viktor's speaking pitch (Hz). */
const VOICE = 116;

export type HeavenPhase = 'off' | 'enter' | 'room' | 'talk' | 'bless' | 'leave';

export interface HeavenHost {
  send(kind: 'portal' | 'bless'): void;
  /** Move the local runner (and its drop shadow) into the room's scene, or back to the course. */
  swapScene(inRoom: boolean): void;
  /** Visual bursts on the course (the portal swallowing someone). */
  burst(p: THREE.Vector3, big: boolean): void;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmp3 = new THREE.Vector3();

export class Heaven {
  /** The portal on the course. */
  readonly portal: PortalView;
  /** The white room, built the first time a portal is placed (so stepping in never hitches). */
  view: HeavenView | null = null;
  phase: HeavenPhase = 'off';
  private phaseT = 0;
  private confirmed = false;
  private announced = false;
  private openAt = Infinity;
  /** Match time you arrived in the room (the server wants a minimum stay). */
  private arrivedMt = 0;
  private sentBless = 0;
  private blessTries = 0;
  private waved = false;
  private doorCloseAt = 0;
  // the speech
  private line = 0;
  private shown = 0;
  private pause = 0;
  private hold = 0;
  private letters = 0;
  private mouth = 0;
  private gesture: ViktorGesture = 'idle';
  private glow = 0;
  // the music
  private music = { level: 0, intensity: 0, pan: 0, room: 0 };
  private fadeOut = 0;
  // the cinematic camera
  private readonly camFrom = new THREE.Vector3();
  private readonly lookFrom = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private shot = -1;
  private shotT = 0;
  private cineFov = 60;
  private local: LocalPlayer | null = null;
  /** While true the move keys do nothing (walking into the light, and while he speaks). */
  locksInput = false;
  /** 0..1: the chase camera frames over your shoulder while you walk up to him. */
  shoulder = 0;
  /**
   * While he speaks: which way the runner walks to its mark (a comfortable
   * distance in front of him, so every camera set-up frames the two of them), or null.
   */
  steer: { x: number; z: number; yaw: number } | null = null;
  private readonly mark = new THREE.Vector3();

  constructor(
    private readonly glowTex: THREE.Texture,
    private readonly cloudTex: THREE.Texture,
    private readonly env: THREE.Texture | null,
    private readonly shadows: boolean,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly cam: CameraController,
    private readonly ui: UI,
    private readonly audio: AudioEngine,
    private readonly host: HeavenHost,
  ) {
    this.portal = new PortalView(glowTex, { beam: true });
  }

  /** In the white room (its scene is the one being drawn). */
  get inRoom() { return this.phase === 'room' || this.phase === 'talk' || this.phase === 'bless' || this.phase === 'leave'; }
  get active() { return this.phase !== 'off'; }

  private ensureView() {
    if (!this.view) this.view = new HeavenView(this.glowTex, this.cloudTex, this.env, this.shadows);
    return this.view;
  }

  // ------------------------------------------------------------------ the portal on the course

  /** This run has a portal: at `p`, turned to `yaw`, opening at match time `at`. */
  placePortal(p: readonly number[], yaw: number, at: number) {
    this.portal.place(p, yaw, at);
    this.openAt = at;
    this.announced = false;
    this.ensureView();
  }

  /** You have been through (or the run is over): it shuts, for you. */
  closePortal(now = false) { this.portal.close(now); this.openAt = Infinity; }

  /** Someone else stepped through: it flares. */
  swallowed() {
    if (!this.portal.placed) return;
    this.portal.pulse();
    this.host.burst(this.portal.centre(tmp), false);
  }

  /**
   * Every frame while on the course: the portal, its music, the announcement
   * when it opens, and walking into it (`canEnter`: alive, on your feet, not
   * already blessed).
   */
  updateCourse(dt: number, t: number, mt: number, local: LocalPlayer | null, canEnter: boolean, listenerRight: THREE.Vector3) {
    const camPos = this.camera.position;
    this.portal.update(t, dt, mt, camPos);
    if (this.phase === 'enter') { this.updateEnter(dt, local); return; }
    const c = this.portal.centre(tmp);
    const d = camPos.distanceTo(c);
    // the music carries across the course, muffled and faint far away, opening up as you come close
    let level = 0, intensity = 0, pan = 0;
    if (this.portal.open > 0.01) {
      level = this.portal.open * (d > 240 ? 0 : 1 / (1 + Math.pow(d / 20, 1.8)));
      intensity = clamp(1 - d / 75, 0, 1);
      tmp2.subVectors(c, camPos);
      pan = d > 0.1 ? tmp2.dot(listenerRight) / d : 0;
    }
    if (this.fadeOut > 0) {
      // just back from Viktor: the music lingers and fades away over the landing pad
      this.fadeOut = Math.max(0, this.fadeOut - dt / 6);
      level = Math.max(level, this.fadeOut * this.fadeOut);
      intensity = Math.max(intensity, this.fadeOut);
    }
    this.mixTo(dt, level, intensity, pan, 0.25);
    if (!this.announced && this.portal.placed && mt >= this.openAt && this.openAt !== Infinity) {
      this.announced = true;
      this.audio.heavenStinger('open', clamp(1.3 - d / 250, 0.45, 1));
      this.ui.objective('A light has opened on the course', 7);
    }
    if (canEnter && local && this.portal.isOpen(mt)) {
      tmp2.set(local.pos.x, local.pos.y + 1, local.pos.z);
      if (tmp2.distanceTo(c) < PORTAL.ENTER_RADIUS) this.enter();
    }
  }

  private mixTo(dt: number, level: number, intensity: number, pan: number, room: number) {
    const m = this.music, k = damp(2.5, dt);
    m.level += (level - m.level) * k;
    m.intensity += (intensity - m.intensity) * k;
    m.pan += (pan - m.pan) * k;
    m.room += (room - m.room) * k;
    this.audio.heavenly(dt, m);
  }

  /** Walked into the light: ask the server, and turn the world white while it answers. */
  private enter() {
    this.phase = 'enter';
    this.phaseT = 0;
    this.confirmed = false;
    this.locksInput = true;
    this.host.send('portal');
    this.portal.pulse();
    this.host.burst(this.portal.centre(tmp), true);
    this.audio.heavenStinger('enter');
    this.cam.addShake(0.2);
    this.ui.whiteout(1, 0.85);
    this.ui.clearTip();
  }

  /** The server agrees you went through. */
  confirmEntry() { if (this.phase === 'enter') this.confirmed = true; }

  private updateEnter(dt: number, local: LocalPlayer | null) {
    this.phaseT += dt;
    // the music swells as the light takes you
    this.mixTo(dt, 1, 1, 0, 0.8);
    if (this.confirmed && this.phaseT >= 0.9 && local) { this.arrive(local); return; }
    if (!this.confirmed && this.phaseT > 3.5) {
      // no answer: the light lets go of you
      this.phase = 'off';
      this.locksInput = false;
      this.ui.whiteout(0, 0.8);
      this.ui.toast('The light faded before it could take you');
    }
  }

  // ------------------------------------------------------------------ the white room

  private arrive(local: LocalPlayer) {
    const v = this.ensureView();
    v.bless(0);
    this.phase = 'room';
    this.phaseT = 0;
    this.arrivedMt = -1;
    this.waved = false;
    this.locksInput = false;
    this.gesture = 'idle';
    this.glow = 0;
    this.host.swapScene(true);
    local.sanctuary = true;
    local.teleport(v.arrivePos.x, v.arrivePos.y, v.arrivePos.z);
    local.motor.yaw = v.arriveYaw;
    local.motor.flying = false;
    // the camera starts a little to one side, so Viktor is not hidden behind you
    this.cam.reset(v.arrivePos, v.arriveYaw + 0.2);
    this.cam.pitch = -0.12;
    v.door.place([v.arrivePos.x, v.arrivePos.y, v.arrivePos.z + DOOR_BEHIND], Math.PI, -Infinity);
    this.doorCloseAt = 3.2;
    this.audio.heavenStinger('arrive');
    this.ui.whiteout(0, 2.6);
    this.ui.objective('Someone is waiting for you', 6);
  }

  /** Keys that matter in the room: E to talk (or to move the speech on), Space / click also move it on. */
  update(dt: number, t: number, mt: number, local: LocalPlayer | null, keys: { interact: boolean; advance: boolean }, paused: boolean) {
    const v = this.view;
    if (!v || !local || !this.inRoom) return;
    if (this.arrivedMt < 0) this.arrivedMt = mt;
    if (paused) { this.audio.heavenly(0, this.music); return; }
    this.phaseT += dt;
    v.update(t, dt, this.camera.position);
    v.focus(local.renderPos);
    if (this.doorCloseAt > 0 && (this.doorCloseAt -= dt) <= 0) v.door.close();
    const head = tmp.copy(v.viktorPos).setY(v.viktorPos.y + 1.72);
    const eyes = tmp2.set(local.renderPos.x, local.renderPos.y + 1.55, local.renderPos.z);
    const d = Math.hypot(local.pos.x - v.viktorPos.x, local.pos.z - v.viktorPos.z);
    this.shoulder = d < 14 ? 1 : 0;
    if (this.phase === 'room') {
      // a gentle current carries a wanderer back toward him
      if (d > HEAVEN_RADIUS) {
        const b = local.motor.body, k = Math.min(3, (d - HEAVEN_RADIUS) * 0.4 + 0.6);
        b.ext.x += ((v.viktorPos.x - b.pos.x) / d) * k * dt * 6;
        b.ext.z += ((v.viktorPos.z - b.pos.z) / d) * k * dt * 6;
      }
      if (!this.waved && d < WAVE_RANGE) { this.waved = true; v.viktor.wave(); }
      if (d < TALK_RANGE) {
        tmp3.copy(head).setY(head.y + 0.55).project(this.camera);
        if (tmp3.z < 1) {
          const w = window.innerWidth, h = window.innerHeight;
          this.ui.interact(clamp((tmp3.x + 1) / 2 * w, 80, w - 80), clamp((1 - tmp3.y) / 2 * h, 60, h - 40), 'Talk to Viktor');
        } else this.ui.interact(null);
        if (keys.interact) this.startTalk(local);
      } else this.ui.interact(null);
      this.mixTo(dt, 1, 0.85, 0, 1);
    } else if (this.phase === 'talk') {
      this.updateTalk(dt, local, keys.interact || keys.advance);
      this.mixTo(dt, 0.5, 0.7, 0, 1);
    } else if (this.phase === 'bless') {
      this.updateBless(dt, local);
      this.mixTo(dt, 1, 1, 0, 1);
    } else if (this.phase === 'leave') {
      this.mixTo(dt, 1, 1, 0, 1);
      // the server has not sent us back yet: ask again (it wants a minimum stay, and messages can be lost)
      this.sentBless -= dt;
      if (this.sentBless <= 0 && mt - this.arrivedMt >= PORTAL.MIN_STAY + 0.2) {
        if (this.blessTries++ < 6) { this.host.send('bless'); this.sentBless = 1.5; }
        else {
          this.phase = 'room';
          this.locksInput = false;
          this.ui.cinema(false);
          this.ui.whiteout(0, 1.2);
          this.ui.toast('The light did not answer. Talk to Viktor again');
        }
      }
    }
    const talking = this.phase === 'talk' || this.phase === 'bless' || this.phase === 'leave';
    this.mouth = Math.max(0, this.mouth - dt * 7);
    v.viktor.update(dt, t, { lookAt: d < 26 || talking ? eyes : null, gesture: this.waved && this.phase === 'room' ? 'idle' : this.gesture, mouth: this.mouth, glow: this.glow });
    if (talking) {
      // step onto the mark, then stand facing him while he speaks
      const mx = this.mark.x - local.pos.x, mz = this.mark.z - local.pos.z, md = Math.hypot(mx, mz);
      this.steer = this.phase === 'talk' && md > 0.1 ? { x: (mx / md) * Math.min(1, md * 1.6), z: (mz / md) * Math.min(1, md * 1.6), yaw: Math.atan2(v.viktorPos.x - local.pos.x, v.viktorPos.z - local.pos.z) } : null;
      const want = Math.atan2(v.viktorPos.x - local.pos.x, v.viktorPos.z - local.pos.z);
      let dy = want - local.motor.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      local.motor.yaw += dy * damp(5, dt);
      this.updateCinema(dt, t, local);
    }
  }

  private startTalk(local: LocalPlayer) {
    this.local = local;
    this.phase = 'talk';
    this.phaseT = 0;
    this.locksInput = true;
    this.line = 0;
    this.shown = 0;
    this.pause = 0.35;
    this.hold = 0;
    this.letters = 0;
    this.gesture = VIKTOR_LINES[0].gesture;
    this.ui.interact(null);
    this.ui.cinema(true);
    this.audio.interact();
    // the camera leaves the chase view from exactly where it is
    this.camFrom.copy(this.camera.position);
    this.camera.getWorldDirection(tmp3);
    this.lookFrom.copy(this.camera.position).addScaledVector(tmp3, 6);
    this.camPos.copy(this.camFrom);
    this.camLook.copy(this.lookFrom);
    this.shot = -1;
    this.cineFov = this.camera.fov;
    // the mark: where the runner stands to listen, 2.4 to 2.9 m in front of him
    const v = this.view;
    if (v && this.local) {
      const P = this.local.pos, V = v.viktorPos;
      let fx = P.x - V.x, fz = P.z - V.z;
      const d = Math.hypot(fx, fz) || 1;
      fx /= d; fz /= d;
      const k = clamp(d, 2.4, 2.9);
      this.mark.set(V.x + fx * k, P.y, V.z + fz * k);
    }
  }

  private updateTalk(dt: number, local: LocalPlayer, advance: boolean) {
    void local;
    const L = VIKTOR_LINES[this.line];
    const full = L.text.length;
    if (advance) {
      if (this.shown < full) { this.shown = full; this.pause = 0; }
      else { this.nextLine(); return; }
    }
    if (this.shown < full) {
      if (this.pause > 0) this.pause -= dt;
      else {
        const before = Math.floor(this.shown);
        this.shown = Math.min(full, this.shown + dt * CPS);
        for (let i = before; i < Math.floor(this.shown); i++) {
          const ch = L.text[i];
          if (ch === ',') { this.pause = PAUSE_COMMA; this.shown = i + 1; break; }
          if (ch === '.') { this.pause = PAUSE_STOP; this.shown = i + 1; break; }
          if (/[a-z]/i.test(ch) && ++this.letters % 3 === 0) {
            // a syllable of his voice, rising a little at the start of a phrase and falling at its end
            const phrase = i / full;
            this.audio.viktorSyllable(VOICE * (1.06 - phrase * 0.1) * (0.96 + Math.random() * 0.08), 0.11 + Math.random() * 0.06);
            this.mouth = 1;
          }
        }
      }
      if (L.then && L.text.indexOf(L.then.from) <= this.shown) this.gesture = L.then.gesture;
      this.hold = 0;
    } else {
      this.hold += dt;
      if (L.then) this.gesture = L.then.gesture;
      if (this.hold > 2.2 + full / 40) this.nextLine();
    }
    this.ui.dialogue({ name: 'Viktor', text: L.text, shown: Math.floor(this.shown), line: this.line, lines: VIKTOR_LINES.length, waiting: this.shown >= full });
    if (this.gesture === 'bless') this.glow = Math.min(0.35, this.glow + dt * 0.12);
  }

  private nextLine() {
    this.line++;
    this.audio.dialogueNext();
    if (this.line >= VIKTOR_LINES.length) { this.startBless(); return; }
    this.shown = 0;
    this.hold = 0;
    this.pause = 0.3;
    this.gesture = VIKTOR_LINES[this.line].gesture;
  }

  private startBless() {
    this.phase = 'bless';
    this.phaseT = 0;
    this.steer = null;
    this.gesture = 'bless';
    this.audio.heavenStinger('bless');
  }

  private updateBless(dt: number, local: LocalPlayer) {
    this.glow = Math.min(1, this.glow + dt * 0.45);
    this.view?.bless(this.glow, local.renderPos);
    // the gift takes hold: the runner rises off the floor into the light
    local.poseOverride = Anim.Fly;
    local.lift = smoothstep(0.3, 2.6, this.phaseT) * 0.9;
    if (this.phaseT > 1.4) this.ui.dialogue(null);
    if (this.phaseT > 2.3 && this.phaseT - dt <= 2.3) this.ui.whiteout(1, 1.2, true);
    if (this.phaseT > 3.7) {
      this.phase = 'leave';
      this.sentBless = 0;
      this.blessTries = 0;
    }
  }

  /**
   * One camera set-up per line: over his shoulder to Viktor; a close shot of
   * Viktor; looking up at him as he points to the sky; a wide shot of the two of
   * them; and craning up and away as the light takes you. Each eases into the
   * next, and every one drifts a little so the frame is never dead still.
   */
  private updateCinema(dt: number, t: number, local: LocalPlayer) {
    const v = this.view!;
    const V = v.viktorPos, P = local.renderPos;
    let fx = V.x - P.x, fz = V.z - P.z;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len; // from the runner toward Viktor
    const rx = -fz, rz = fx; // to the runner's right as it faces him
    const shot = this.phase === 'talk' ? this.line : 4;
    if (shot !== this.shot) {
      if (this.shot >= 0) { this.camFrom.copy(this.camPos); this.lookFrom.copy(this.camLook); }
      this.shot = shot;
      this.shotT = 0;
    }
    this.shotT += dt;
    const drift = Math.sin(t * 0.35) * 0.06;
    const face = tmp.set(V.x, V.y + 1.66, V.z);
    let fov = 50;
    const pos = tmp2, look = tmp3;
    const ease = this.shot === 4 ? 2.4 : 1.5;
    switch (shot) {
      case 0: // over the runner's right shoulder, easing in
        pos.set(P.x - fx * (2.9 - this.shotT * 0.05) + rx * 1.15, P.y + 1.85 + drift, P.z - fz * (2.9 - this.shotT * 0.05) + rz * 1.15);
        look.set(lerp(P.x, face.x, 0.88), face.y - 0.22, lerp(P.z, face.z, 0.88));
        fov = 52;
        break;
      case 1: // close on Viktor, just off his eyeline
        // (always in front of the runner, so its back never fills the frame)
        pos.set(V.x - fx * Math.min(1.6, len - 0.9) + rx * 0.45, V.y + 1.62 + drift, V.z - fz * Math.min(1.6, len - 0.9) + rz * 0.45);
        look.set(face.x, face.y - 0.16, face.z);
        fov = 42;
        break;
      case 2: // low, looking up at him and the hand raised to the sky
        pos.set(V.x - fx * Math.min(1.9, len - 0.8) - rx * 1.45, V.y + 0.95, V.z - fz * Math.min(1.9, len - 0.8) - rz * 1.45);
        look.set(face.x, face.y - 0.12 + drift, face.z);
        fov = 60;
        break;
      case 3: // wide, from the side: the two of them
        pos.set((P.x + V.x) / 2 + rx * 4.6, P.y + 1.5 + drift, (P.z + V.z) / 2 + rz * 4.6);
        look.set((P.x + V.x) / 2, P.y + 1.35, (P.z + V.z) / 2);
        fov = 50;
        break;
      default: { // the blessing: crane up and back as the light gathers
        const k = smoothstep(0, 3.5, this.shotT);
        pos.set((P.x + V.x) / 2 + rx * (4.6 + k * 2.5) - fx * k * 2, P.y + 1.5 + k * 3.2, (P.z + V.z) / 2 + rz * (4.6 + k * 2.5) - fz * k * 2);
        look.set((P.x + V.x) / 2, P.y + 1.4 + k * 0.9, (P.z + V.z) / 2);
        fov = 54;
      }
    }
    const k = smoothstep(0, ease, this.shotT);
    this.camPos.lerpVectors(this.camFrom, pos, k);
    this.camLook.lerpVectors(this.lookFrom, look, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.cineFov += (fov - this.cineFov) * damp(2, dt);
    if (Math.abs(this.camera.fov - this.cineFov) > 0.01) { this.camera.fov = this.cineFov; this.camera.updateProjectionMatrix(); }
  }

  /** The camera is ours (a speech set-up), not the chase camera's. */
  get ownsCamera() { return this.phase === 'talk' || this.phase === 'bless' || this.phase === 'leave'; }

  // ------------------------------------------------------------------ back to the course

  /**
   * The server sent you back to `p` able to fly. Also used when a reconnect
   * lands you straight back (then there is no room to leave).
   */
  returned(local: LocalPlayer, p: readonly number[], spawnYaw: number) {
    if (this.inRoom) this.host.swapScene(false);
    const wasAway = this.phase !== 'off';
    this.phase = 'off';
    this.locksInput = false;
    local.sanctuary = false;
    local.poseOverride = null;
    local.lift = 0;
    local.motor.canFly = true;
    local.motor.flying = false;
    local.teleport(p[0], p[1], p[2]);
    local.motor.yaw = spawnYaw;
    this.cam.reset(new THREE.Vector3(p[0], p[1], p[2]), spawnYaw);
    this.ui.cinema(false);
    this.ui.dialogue(null);
    this.ui.interact(null);
    this.closePortal();
    this.fadeOut = wasAway ? 1 : 0;
    this.ui.whiteout(0, wasAway ? 2.2 : 0.3, true);
    if (wasAway) this.audio.heavenStinger('return');
    this.ui.big('Flight', 'gold', 'Left click to take off', 4.5);
    this.ui.tip(FLIGHT_TIP, 14);
  }

  /** The run is over (or thrown away): put everything back as it was. */
  reset() {
    if (this.inRoom) this.host.swapScene(false);
    this.phase = 'off';
    this.steer = null;
    this.locksInput = false;
    this.fadeOut = 0;
    this.closePortal(true);
    this.view?.door.close(true);
    this.ui.cinema(false);
    this.ui.dialogue(null);
    this.ui.interact(null);
    this.ui.whiteout(0, 0.01);
    this.music.level = 0;
    this.audio.heavenly(0.016, { level: 0, intensity: 0, pan: 0, room: 0 });
  }
}
