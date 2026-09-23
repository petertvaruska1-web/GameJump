// Client-side proxies for server-simulated actors (remote players, enemies),
// rendered with snapshot interpolation.

import * as THREE from 'three';
import type { EnemyKind } from '../../shared/constants';
import { Anim } from '../../shared/physics/character';
import { Status, type EnemySnap, type PlayerSnap } from '../../shared/protocol';
import { InterpBuffer } from '../net/Interp';
import { localDir } from '../player/LocalPlayer';
import { CharacterModel, PLAYER_CSS } from '../render/CharacterModel';
import { EnemyView } from '../render/EnemyView';

export class RemotePlayer {
  readonly model: CharacterModel;
  readonly buf = new InterpBuffer();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  status: Status = Status.Alive;
  anim: number = Anim.Idle;
  connected = true;
  private tmp: number[] = [];
  private lastPos = new THREE.Vector3();
  private lastYaw = 0;
  private landT = 0;
  private hasPos = false;

  constructor(readonly id: number, public name: string, shadows: boolean) {
    this.model = new CharacterModel((id - 1) % 3, shadows);
    this.model.setNameTag(name, PLAYER_CSS[(id - 1) % 3]);
  }

  push(ts: number, s: PlayerSnap) {
    this.buf.push(ts, [s[1], s[2], s[3], s[4]]);
    this.anim = s[5];
    this.status = s[6] as Status;
  }

  place(x: number, y: number, z: number, yaw: number) {
    this.buf.clear();
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.lastPos.copy(this.pos);
    this.hasPos = true;
    this.model.root.position.copy(this.pos);
  }

  update(renderT: number, dt: number, t: number) {
    if (this.buf.sample(renderT, this.tmp, [3])) {
      this.pos.set(this.tmp[0], this.tmp[1], this.tmp[2]);
      this.yaw = this.tmp[3];
    }
    if (!this.hasPos) { this.lastPos.copy(this.pos); this.hasPos = true; }
    if (dt > 0) {
      this.vel.subVectors(this.pos, this.lastPos).divideScalar(dt);
      if (this.vel.lengthSq() > 900) this.vel.set(0, 0, 0);
    }
    this.lastPos.copy(this.pos);
    let turn = 0;
    if (dt > 0) {
      let d = this.yaw - this.lastYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turn = d / dt;
    }
    this.lastYaw = this.yaw;
    const anim = this.status === Status.Dead ? Anim.Dead : this.status === Status.Finished ? Anim.Finished : this.anim;
    if (anim === Anim.Land) this.landT = 0.6; else this.landT = Math.max(0, this.landT - dt * 3);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    this.model.root.visible = this.status !== Status.Left;
    this.model.setTagVisible(this.status === Status.Alive);
    const local = localDir(this.vel.x, this.vel.z, this.yaw);
    this.model.update({
      speed: Math.hypot(this.vel.x, this.vel.z), vy: this.vel.y, anim, dt, turn,
      land: this.landT, t, fwd: local[0], side: local[1],
      // a remote body's ground contact is not sent: it is resting when it stops falling
      vel: this.vel, grounded: Math.abs(this.vel.y) < 0.6,
    });
  }
}

export class EnemyProxy {
  readonly view: EnemyView;
  readonly buf = new InterpBuffer();
  readonly pos = new THREE.Vector3();
  yaw = 0;
  state = 0;
  target = 0;
  aux = 0;
  private tmp: number[] = [];
  seen = false;

  constructor(readonly id: number, readonly kind: EnemyKind, shadows: boolean, glowTex: THREE.Texture, home: [number, number, number], yaw: number) {
    this.view = new EnemyView(kind, shadows, glowTex);
    this.pos.set(home[0], home[1], home[2]);
    this.yaw = yaw;
    this.view.root.position.copy(this.pos);
  }

  push(ts: number, s: EnemySnap) {
    this.buf.push(ts, [s[1], s[2], s[3], s[4]]);
    this.state = s[5];
    this.target = s[6];
    this.aux = s[7];
    this.seen = true;
  }

  reset(home: [number, number, number], yaw: number) {
    this.buf.clear();
    this.pos.set(home[0], home[1], home[2]);
    this.yaw = yaw;
    this.state = 0; this.target = 0; this.aux = 0;
  }

  update(renderT: number, dt: number, t: number, cam: THREE.Vector3) {
    if (this.buf.sample(renderT, this.tmp, [3])) {
      this.pos.set(this.tmp[0], this.tmp[1], this.tmp[2]);
      this.yaw = this.tmp[3];
    }
    this.view.update(this.pos, this.yaw, this.state, this.aux, dt, t, this.pos.distanceTo(cam));
  }
}
