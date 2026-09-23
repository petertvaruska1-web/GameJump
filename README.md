# Skyfall Escape

A 1–3 player co-op 3D parkour escape game for desktop browsers. Runners start on a
landing pad high above a sea of clouds and have to reach the beacon on the Spire at
the far side of an abandoned sky-industrial complex. There's no combat. You get
there by running, sliding, grapple-swinging, riding zip lines and launch pads,
timing laser gates, fighting conveyor belts, picking a route and staying out of
sight, with the odd power crate to help.

> Keep moving. Don't fall. Don't get seen. And if you do get seen, **run**.

Built with **Three.js + TypeScript + Vite** on the client and **Node.js + WebSockets
(`ws`)** for the authoritative multiplayer server.

---

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` starts both processes:

| Process | URL | Purpose |
|---|---|---|
| Vite client | http://localhost:5173 | The game (hot reload) |
| Game server | ws://localhost:8787/ws | Rooms, enemies, authoritative state (proxied by Vite at `/ws`) |

Open http://localhost:5173 and pick one:

- **Play — create game**: creates a room and shows a 4-letter code.
- **Join game**: enter a friend's code. Up to 3 players per room.
- **Solo offline**: runs the same authoritative simulation inside the page, with no server.

Friends on your LAN can join with `http://<your-ip>:5173` (Vite listens on all interfaces).

### Production

```bash
npm run build     # vite build -> dist/client, esbuild -> dist/server/index.js
npm start         # serves the client + WebSocket on http://localhost:8787
```

In production a single Node process serves the static client and the `/ws` endpoint.
It honours `PORT` (for hosting platforms), then `GAME_SERVER_PORT`, then defaults to `8787`.
`GAME_DEBUG=1` enables the debug commands on a production server.

### Static hosting (Netlify)

`netlify.toml` in the repository root carries the settings, so a Netlify site
connected to this repo needs nothing configured by hand:

| Setting | Value |
|---|---|
| Build command | `npm run build:client` |
| Publish directory | `dist/client` |
| Node version | 22 |

Without it Netlify publishes the repository root, which serves the development
`index.html` — the one that points at `/src/main.ts`. A browser cannot run
TypeScript, so the page comes up **white**. Publishing `dist/client` serves the
compiled bundle instead. If the site was deployed before this file existed,
clear any build command and publish directory set in the Netlify UI, since those
override the file, and redeploy.

What a static host can and cannot do:

- **Solo offline runs work completely.** The whole simulation — level, enemies,
  lasers, physics — runs inside the page, so the deployed link is a complete
  single-player game with nothing else to set up.
- **Online rooms need a server somewhere that speaks WebSocket**, which Netlify
  is not: it serves files, it does not run `dist/server/index.js`. Until one
  exists, "Play — create game" and "Join game" report that no game server
  answered and offer the offline run.
- When you do have one, point the site at it without touching any code: set
  `VITE_SERVER_URL` (e.g. `wss://host.example/ws`) in the Netlify site's
  environment variables and redeploy. It must be `wss://`, because an https page
  is not allowed to open an unencrypted socket. A `?server=wss://…` query
  parameter overrides it for a one-off test. With neither set the client asks
  for `/ws` on whatever host served the page, which is what `npm start` and the
  dev server both provide, and the variable compiles out of the bundle entirely.

## Controls

| Input | Action |
|---|---|
| `W` `A` `S` `D` | Move relative to the camera |
| Mouse | Look (click the game to capture the mouse) |
| `Space` | Jump (a tap and a hold jump the same distance). On a zip line: let go |
| `Shift` | Sprint (needed for the long gaps) |
| `Space` in the air | Front flip: a tuck that carries the jump ~0.9 m further |
| `W` at a ledge | Climb: hold forward and you pull yourself up |
| `Q` / `E` | Dash left / right: a 2.6 m sidestep out of a charge, on the ground or in the air |
| `C` | Slide (while running): low under gaps, chest-high beams and shots. Press again to stand |
| Right mouse (hold) | Grapple the anchor marked by the green reticle and hang on while you hold it; let go of the button (or press `Space`) to drop off |
| `Esc` | Pause menu / release the mouse (on your own, the pause menu can also restart the run) |
| `Space` / `E` while dead or finished | Cycle the spectated teammate |

The runner stays squared up to the camera and strafes, the way third-person
action games handle it: stepping left or right with `A` / `D` no longer swings the
whole body round to face the new direction. The gait blends between running
forward, side-stepping and backpedalling from the direction you are actually
travelling, and the camera only swings in behind you when you are heading away
from it, so a strafe is not slowly dragged back into a forward run.

Movement: running, sprinting and jumping, with coyote time, jump buffering,
consistent full-height jumps, air control, automatic step-up, vaulting over
waist-high obstacles, and a ledge grab when a jump lands just short of a chest-high
ledge. A soft shadow on the ground straight below you shows where a jump will come
down. The sun's own shadow falls well off to the side, and the Low preset has none.
On top of that come two movement skills:

| Skill | How it works | Where it's useful |
|---|---|---|
| **Slide** (`C`) | From a run you drop to 0.9 m tall and keep your speed (a little boost, then friction; you pick up speed downhill). Under a low ceiling you keep crawling forward until there's room to stand. Jumping out of a slide keeps up to 9.8 m/s (a sprint is 8.9). | Required: the hangar's jammed shutter and tunnel (left), the flue walkway's beam (right). Elsewhere: chest-high laser beams, faster descents on stairs and ramps, a stalker-proof escape through low gaps (they're too tall to follow), and dodging a Sentinel shot. It only dodges a shot if you're not already sliding when it fires. |
| **Grapple** (right mouse) | Hook a glowing green anchor within 17 m that is ahead of you and in sight. The hook pulls you toward the anchor and off the ground, so it works from a standstill; the rope then reels in to 85% of its length, and holding a direction pushes you along the arc rather than against the rope. You hang on while you hold the button; let go of it (or press `Space`) as you swing up. A quick tap still holds on for 0.3 s. Touching the ground unhooks you. | Required: the viaduct gap (centre) and a double swing between the smokestacks (right). Six optional anchors elsewhere: rescue hooks beside hard jumps (rooftops, skybridge hops, Leap of Faith, broken stairway) and detours to hidden crates (twin rails, launch yard). |

Two more are built on those keys. A **front flip** comes from pressing `Space`
again while you are off the ground — a quick second tap after the jump, or
seconds into a long fall; there is no window to hit. You tuck through a full
forward rotation, which adds about 0.9 m to a sprint jump (5.93 m to 6.84 m)
without raising it more than 0.09 m, and only one fits in an airtime, so it is a
longer jump rather than a second one. The one time a press in the air is *not* a
flip is on the way down with the ground under 1.5 m away, where it still buffers
into a jump for the moment you land. While you are tucked a Sentinel aims below
your chest, so a shot that leaves during the flip passes over you as you land.

The **dash** (`Q` left, `E` right) is a 2.6 m sidestep, taken from wherever the
camera is facing, with no cooldown — like a jump, it is ready the moment the last
one finishes. It is the answer to something charging you: a Stalker running
head-on cannot turn with it, and in the headless check it fails to land a hit
from any trigger distance between 2 and 4.5 m, where a runner who keeps running
straight is always caught. Dash from further out and it simply closes again —
so you dash a second time. It is fenced in so it can never become free
traversal: on the ground you cannot jump out of it and it ends at running speed,
and in the air (once per jump) it is thrown square across your flight path, with
the jump handed back when it finishes, so the jump reaches exactly as far as it
would have.

The **ledge climb** has no key at all: hold forward. Come up short on a jump and
you catch the lip and haul yourself up; walk into something between waist and
head height (1.0-2.3 m), let it stop you and keep leaning on it, and you climb
that too. It is deliberately limited -- anything taller is unclimbable, nothing
you are merely brushing past at speed counts, a railing or a pipe is rejected
because there is no floor behind its lip, the pull-up takes up to 0.7 s during
which you cannot act, you arrive at walking pace, and there is a 0.9 s pause
before the next one.

There's no double jump or wall run.

## Obstacles

Beyond gaps, beams, moving platforms, crumbling slabs, rotating arms and wind gusts,
the course has four interactive obstacle types. Each one shows a one-time tip the
first time you get close.

| Obstacle | How it works |
|---|---|
| **Zip lines** | Jump into a cable to grab it and slide downhill (up to 15 m/s, braking before the end). `Space` lets go early. Five cables: across the Cable Yards gap, the wrecked skybridge's surviving suspension cable, and three across the final chasm. |
| **Launch pads** | Step on one and it throws you in a fixed arc onto the next platform, aimed from wherever you stepped on. You can steer a little in the air. Five pads: the terrace gardens, the antenna array, and a three-pad climb up the Cable Station. |
| **Lasers** | Kill on contact. Gates blink on a cycle and flicker for 0.6 s before switching on. Low beams sweep along corridors or spin like a windmill: jump them. Sliding fences cover half a deck and move across it, and a curtain blinks across the fast zip line. 12 gates or beams in total. |
| **Conveyor belts** | Carry you along with them. Feed belts push you into laser gates, cross belts push you toward the edge, treadmills fight you uphill, and a boost belt adds its speed to your jump over a gap you can't clear on foot. In the foundry, the south-bound belt slows you enough for the stalker to catch up. |

All four are pure functions of the shared match clock (lasers) or of the level data
(belts, pads, cables), so every client and the server agree on them.

### Power crates

Eight glowing crates sit around the course, mostly just off the main path: on a
container, on a booth roof, behind a furnace, between the water tower's legs, on
the antenna dish deck, on the relay mast, and on two grapple-only ledges. Walk
through one to take it. Each crate can be taken once per match, by whoever reaches
it first. Each route has two, and the Upper Works has two.

| Power | Effect |
|---|---|
| **Shield** (3 crates) | Soaks one hit from a stalker, drone, Sentinel shot or laser. You then get 2.2 s of grace, and the attacker is stunned for 3.5 s before it gives up the chase. It doesn't save you from falling. |
| **Cloak** (3 crates) | For 15 s enemies can't see you, and any that were chasing you lose you. You turn ghostly. |
| **Boost** (2 crates) | For 22 s you run 22% faster (a sprint of 10.9 m/s, which leaves any stalker behind) and take off 8% harder, so a sprint jump carries about a third further (5.9 m -> 7.8 m) while rising only a little higher. Your boots glow and the view widens at speed. |

## The level

The map lives in `shared/level/map/*` as data, built with a small toolkit
(`shared/level/builder.ts`) of platforms, beams, stairs and ramps, broken bridges,
buildings with doorways, containers, movers, crumbling slabs, sweepers, wind zones,
conveyor belts, launch pads, zip lines and laser gates/bars/windmills.

Everything that looks solid is solid. Each prop with some bulk gets an invisible
collision proxy roughly its shape: lamp posts, antennas, windsocks, barrels, tanks,
chimneys, pipes, satellite dishes, rubble piles and dead trees. You can bump into
them and stand on them. The proxies don't block enemy sight, so the AI sees the
level as it did before. The same goes for the second girder over the broken
bridge, the twin rails' sleepers and the reactor ring's maintenance spokes.

```
                         SPIRE (finish beacon)
                 elevator /          \ broken stairway
                          FOOTHILLS
              zip lines: west (fast, laser curtain) | east (via relay mast)
                  CABLE STATION  <- three launch pads up from the Launch Yard
          assembly line (belts) /          \ laser galleries
                        REACTOR RING  (all routes merge)
     cooling works         |  cable yards   \  wrecked skybridge -> Leap of Faith
     hangar / gardens      |  viaduct          antenna array
     foundry               |  gantry   <---- crane-jib tightrope shortcut
     scaffold yard         |  plaza          rooftops / smokestacks
           \_______________ START _______________/
```

| Route | Character |
|---|---|
| **Left** (covered walkway → scaffold yard → catwalk → foundry → pipe yard → hangar → terrace gardens → cooling hall → pump station) | Longest. Most cover, easy jumps, and Stalkers you can sneak around. Conveyor belts in the foundry, a launch pad over the gardens, and a laser-locked exit from the pump station. **Slide obstacle:** the hangar's north shutter is jammed 0.95 m above the floor over an 8 m baggage tunnel. You must slide through, and the two stalkers inside can't follow. |
| **Centre** (broken bridge → plaza → gantry → twin rails → collapsed viaduct → cable yards) | Medium length and open, with Sentinel sightlines, movers, a sweeper and crumbling floor. A laser gate and a zip line across the Cable Yards. **Grapple obstacle:** the viaduct's middle span collapsed, leaving a 14 m gap. Swing across on a hook hanging from the surviving arch; a stalker paces the slab you jump from. |
| **Right** (rooftops → water-tower roof → smokestacks → antenna array → wrecked skybridge) | Shortest. Brutal sprint jumps, wind gusts on narrow beams, Sentinels and Drones. A launch pad up the antenna array and a zip line along the skybridge's last cable. **Grapple + slide obstacle:** between the smokestacks you swing from one hook to the next without touching down. You land on a railed flue walkway where a chest-high beam sweeps back and forth, and slide under it. |

Cross-links let players switch routes: the pipe crossing, the plaza container climb,
the foundry bridge and the hangar link. There are two high-risk shortcuts:

- The **crane jib**, a 0.6 m wide, 75 m long tightrope from the water-tower roof to the gantry.
- The **Leap of Faith**, a 9.5 m sprint jump off the antenna array onto the reactor ring 10 m below.

At the reactor ring the routes merge, then split again into the **Upper Works**:

| Branch | Character |
|---|---|
| **Assembly Line** (+X) | Conveyor belts: a feed belt into a blinking gate, a sorting floor of cross belts, an uphill treadmill, a deck with a sweeping low laser, and a boost belt into a 7.5 m gap. A Sentinel and a Drone. |
| **Laser Galleries** (-X) | A security checkpoint whose two doorway gates blink out of phase, a corridor with a sweeping low beam, two sliding laser fences, a laser windmill, and a gated deck guarded by a Stalker. |

Both lead to the **Launch Yard**, where three launch pads throw you up the Cable
Station. From its roof two zip-line routes cross the final chasm to the
**Foothills**. The west cable is one long, fast ride through a blinking laser curtain,
so you have to time your grab. The east one stops at a relay mast with a Drone.
From the Foothills you take either the slow covered **service elevator** or the fast,
exposed **broken stairway** to the Spire.

The course is about 920 m deep with 42 enemies (14 stalkers, 13 sentinels, 15 drones).
Stalkers hit harder than they used to: they see further, commit sooner and chase
faster — though a stalker's top speed is capped 2% under your sprint, so it can
never outrun you, only wear you down. Drones see almost all round but are slower than a
sprint, give up quickly and keep close to their patrol. Sentinels are the
opposite of dangerous at range: their aim is about half as accurate as it
originally was, and their sight is down from 58 m to 39 m. The route bot's flawless runs take
about 131–135 s, including the waits at laser gates. Real runs with scouting, hiding
and waiting for gaps in patrols take several minutes. There are no checkpoints, so most runs end in a fall — the results screen's
**Run it again** (or `R`) puts the host straight into a fresh countdown rather than back
round through the lobby, which is still there for changing who is in the room.
The results screen says where your run ended and how far along the course that
was, as a bar with this browser's best run marked on it. It flags a run that got
further than ever, or a faster escape (kept in `localStorage`).

### What each route asks of you, measured

`npm run balance` drives the route bot from the start to the North Junction (where all
three routes leave the Reactor Ring) at ten different arrival times and at deliberately
human skill levels, and replays each run through the real server with enemies on. The
three routes come out as three different tests rather than three versions of one:

| | Left | Centre | Right |
|---|---|---|---|
| Clean run to the North Junction | 86.6 s | 84.3 s | 82.7 s (80.7 s by the Leap of Faith) |
| A jump taken this early kills you | never (tested to 1.5 m early) | about 1.2 m (the Cable Yards mover) | 1.0 m (the skybridge mover) |
| Stopping a second to line up a jump | always safe | kills on every crumbling floor | kills on its crumbling slabs |
| Would-be deaths for a runner who ignores enemies | 2.9, mostly stalkers | 4.6, stalkers and drones | 1.5, drones and sentinels |

The **left** asks for patience and stealth: nothing underfoot punishes you for waiting,
but its interiors are stalker country. The **centre** asks for momentum across open,
watched ground: crumbling floors punish hesitation, and it spends the most time under
enemy eyes. The **right** asks for precise jumping and pays for it with the shortest
time. Static gaps are forgiving everywhere because a short jump catches the ledge, so
each route's precision test is a moving platform, where there is no ledge to catch.

Tuning that came out of these measurements (each a small change to one obstacle):

- The right route killed a *perfect* runner at two of ten arrival times, which is luck
  rather than skill. The laser bar on the flue walkway now takes 5 s a sweep instead of
  4.2 s, so landing off the double swing always leaves time to slide under it, and the
  antenna mover rests 24% of its cycle at each end instead of 18%, so its boarding
  window can always be made. The skybridge mover, the route's real precision test, is
  unchanged.
- The centre's movers forgave a jump taken as early as the left route's easy ones do. The
  gap onto the Cable Yards mover is 10 cm wider (the yard before it 10 cm shorter, so the
  mover and everything after it are where they were).
- Left alone on purpose: the centre's gantry sweeper (at any faster setting tried, even a
  perfect run is thrown off at some arrival times) and the left route (widening the gap
  onto its one mover jumps straight from forgiving to right-route-hard, with no step
  between).
- Stalkers were moved out of spots where they caught you with nowhere to dash
  (`npx tsx scripts/enemy-audit.ts` replays the routes and counts those). The right
  route lost its two (the water-tower stalker waited at the top of the pipe climb and
  caught every run), so it is now the gentlest on enemies. The centre's plaza stalker,
  which had been stuck against a wall, now patrols, so the centre became the most
  hunted, but it charges across open floor, where one dash takes you out of its way.

## Enemies

Every enemy has a fixed post and a finite state machine:
`IDLE/PATROL → ALERT → CHASE → ATTACK`, and when it loses you, `SEARCH → RETURN → IDLE`.
Detection needs all three of: within range, inside the field-of-view cone, and a
clear line of sight (raycast against sight-blocking geometry; grates and railings
don't block it). Vision runs at 10–12 Hz, staggered across enemies. Nothing is omniscient.
Break line of sight and they search your last known position, then walk back to their post.

| Enemy | Behaviour |
|---|---|
| **Stalker** (melee, 14 of them) | Spots you at 34 m through a 135 deg cone and commits in 0.44 s. Chases at 8.72 m/s — exactly 2% under your 8.9 m/s sprint, with no burst above it, so a sprint always pulls away but only by about 0.2 m/s, and a jog is hopeless. Stops at edges, but leaps gaps up to 6.25 m while chasing. Contact inside 1.31 m kills. Break line of sight, slide through a gap it cannot follow, or keep sprinting. |
| **Sentinel** (ranged, 13 of them) | Stationary turret with a visible searchlight. Sees 39 m through a 90 deg cone (51 m once it is already tracking you). Charges for 0.8 s (a glowing orb), then fires a slow, visible projectile with wide aim scatter and a weak lead — about 10% per shot at 30 m if you stand still, 2–4% if you keep moving. A hit kills. |
| **Drone** (flyer, 15 of them) | Hovers on a patrol, sees 40 m almost all round, then flies straight at you (vertically too) at 7.3 m/s and climbs over obstacles, diving at 10.2 m/s over the last 4.5 m. A sprint pulls away from one. It gives up 2 s after losing sight of you and never follows more than 32 m from its post, so breaking line of sight and putting some distance in loses it. Contact kills. |

Under the run timer the HUD names the area you are in — Foundry, Smokestacks,
Reactor Ring — flaring as you cross into it and then settling to a quiet label,
with a hairline bar showing how far along the course you are. The 36 areas come
straight from the level data, so they are also what teammates call places over
voice, and `npm run check:map` fails a map edit that leaves part of the course
unnamed.

A red screen vignette and a pulsing heartbeat tell you when something is hunting you.
A `!` or `?` above an enemy shows its state.

## How the runner moves

The runner is a few dozen primitives animated procedurally, and the gait is built to
read as a person rather than a mechanism. Ankles roll through each step (toes point at
push-off, lift before the heel lands), the hips sway toward the loaded leg and drop on
the swinging side, the arms swing a beat behind the legs with the elbows tightening on
the forward swing, and the two sides are never exactly equal. The head counter-rotates
against the lean, the bank and the shoulder twist, so the eyeline stays level and turns
slightly into a turn. Standing still, the runner breathes and shifts its weight from
foot to foot instead of freezing.

Sideways and backward travel get their own gait rather than a reoriented forward
run: shorter strides, the legs swinging out and crossing over from the hips, the
arms tucked in with the leading one flared, the body banking into the step, the
hips turning toward the direction of travel while the shoulders stay square to
the camera, and a backpedal leaning back with the cycle running in reverse.

The two newest moves are animated the same way. A front flip turns the whole runner
about the **hips**, not the feet: the rig has a pivot group at hip height for exactly
this, and the rotation runs on a smoothstep so it whips through the middle of the turn
and eases at both ends, while the legs tuck to the chest and open again to spot the
landing. If a landing cuts the flip short the remaining rotation still plays out, fast,
so the body rolls out of it instead of snapping upright. A dash banks the body into the
direction of travel, swings both legs sideways from the hips (the lead leg further than
the trailing one), throws the near arm out for balance and turns the head to look where
it is going, all riding a single sine so it rises and settles rather than popping.

Turning is smoothed in the controller too: the facing accelerates into a turn and eases
out of it (`PLAYER.TURN_ACCEL`) rather than snapping onto a new heading, and the bank
into a turn comes from a filtered turn rate, so a sharp change of direction reads as a
lean rather than a flick.

## Bodies and impacts

Death is not the end of the physics. A body is thrown by whatever killed it (away from a
stalker or drone, along the shot, straight up off a laser), keeps the runner's own
momentum, then falls, tumbles, slides to a stop with friction, rides moving platforms and
conveyors, gets swatted by sweeper arms and tugged by gusts. If the platform or slab
holding it goes away, it drops. The server simulates every body — including after the
match ends, so the last fall plays out for everyone watching — and the client runs the
same code for your own body so it looks smooth at once.

A hit your shield soaks shoves you clear of the attacker instead of killing you, and
landings above 17 m/s cost you a beat and shake the camera.

## Multiplayer model

- The **server is authoritative** for deaths, finishes, enemy AI, projectiles,
  crumbling floors, match flow and room membership.
- **Clients predict their own movement** with the shared controller
  (`shared/physics/character.ts`) and send compact state at 30 Hz. The server
  rejects implausible movement (speed and teleport checks) and replies with a correction.
- The server decides fall deaths from its own collision raycasts, and melee,
  projectile and drone kills from its own simulation. It checks the finish zone itself.
  Riding a zip line over open air is not a fall.
- Crates are handed out by the server, first come first served. The client hides a crate
  as soon as you touch it and brings it back if the server gives it to someone else.
  Shields, cloaks and boosts are tracked on the server. It knows when you're sliding
  from your reported animation, and uses the smaller body for shots and lasers.
- Lasers are checked by both sides. The client detects a touch at its synced clock and
  reports it straight away, so the death shows without lag. The server re-checks every
  state message against the lasers at the client's reported match time (clamped to
  the last 0.35 s) with a slightly smaller body, so latency never kills you unfairly.
  A client can only report its own death.
- Snapshots go out at 20 Hz. Remote players and enemies render about 110 ms in the
  past with interpolation. Projectiles are simulated deterministically on clients
  from their spawn event.
- Moving platforms, sweepers and wind gusts are pure functions of the shared match clock.
  Clients keep a synchronised clock through ping/pong.
- Players don't collide with each other. When one dies, the others keep going.
  The match ends when everyone has finished or died.
- If the connection drops mid-match, the client reconnects on its own (30 s grace)
  and the player resumes where the server last saw them. The same works after a page refresh.

## Project layout

```
shared/                 code used by both client and server
  constants.ts          all tuning (movement, enemies, network)
  protocol.ts           message types
  math.ts, hazards.ts
  physics/world.ts      collision world: yaw-rotated boxes & ramps, grid broad-phase, raycasts, movers
  physics/character.ts  character controller (coyote, buffer, mantle, carry, wind)
  level/                level schema, builder toolkit, map sections
  sim/room.ts           authoritative room: lobby, match flow, validation, deaths
  sim/enemy.ts          enemy FSM + perception
  sim/manager.ts        room registry and per-connection sessions
server/index.ts         HTTP static hosting + WebSocket endpoint + fixed-tick loop
src/                    client
  game/Game.ts          orchestrator (menu -> lobby -> match -> results)
  game/Actors.ts        remote players / enemies (interpolated)
  player/               local player prediction, third-person camera
  render/               renderer, sky/clouds, level/props builders, character & enemy models, effects
  net/                  connection (WebSocket or offline), interpolation buffers
  ui/                   DOM menus, lobby, HUD, pause, results
  audio/Audio.ts        procedural WebAudio (no asset files)
  debug/Debug.ts        developer overlay
scripts/                headless test and design tools
```

## Tests & tools

```bash
npm test               # map validation + route bot + enemy AI scenarios + obstacle authority checks + multiplayer
npm run check:map      # validates gaps against measured jump limits, renders dist/map.svg
npm run test:routes    # a bot drives the real controller along every route start -> finish
npm run test:ai        # detect / chase / kill / lose-target scenarios for each enemy type
npm run sim:jumps      # measures jump distances for level-design rules
npm run test:balance   # stalker pursuit vs sprint/jog + sentinel hit chances
npm run balance        # route balance report: time, early / wandering / late / hesitant runs and
#                        enemy replays per main route, at ten arrival times (a few minutes)
npm run test:hazards   # server: lasers, zip/grapple not falls, launch arcs, crates, shield, cloak, slide hitbox, bodies
npm run test:moves     # movement: climb reach/limit/cooldown, hooking from a standstill, swing release windows,
#                        what a flip adds to a jump, and a dash beating a head-on stalker charge
#                        (it also prints slide length and tunnel clearance; SWEEP=1 adds more swing geometries)
# clumsy-player check: the bot takes off 1.2 m before every edge
SLOPPY=1.2 npx tsx scripts/bot-routes.ts
npm run test:server    # two headless clients against a server it starts itself: room codes, the
#                        ready gate, a synchronised countdown, snapshots, a server-judged fall, a
#                        rejected teleport, the end of a match and restarting from the results.
#                        WS=ws://host/ws points it at a server that is already running instead.
npm run typecheck
```

The route bot runs all three main routes (each continuing through the Upper Works to
the Spire), both Upper Works branches on their own, both shortcuts and every cross-link
with the actual movement code, plus the two grapple detours. It waits for laser gates,
jumps low beams and sweeper arms, boards movers only when they are resting or coming its
way, slides under high beams and through low gaps, rides launch pads, and only grabs a
zip line when its ride will clear the laser curtain. Crumbling slabs fall under it as
they do on the server. For grapple swings it
simulates copies of the controller forward to pick a release moment that lands well
inside the far platform. That includes the anchor-to-anchor double swing, and it pumps
the swing when no release works yet (giving up after 12 s, which is reported as a SWING
failure). A level edit that makes a jump impossible or a laser unavoidable shows up as a
failure.

## Debug mode

Available in the dev build, or with `?debug=1` in the URL. The server must also allow
debug commands, which is the default in dev.

| Key | Tool |
|---|---|
| `F3` | Overlay: FPS, position, current section, speed, ping, players, nearest enemies and their states |
| `F4` | Free camera (WASD, mouse, Shift fast, E/Q up/down) |
| `F6` | Enemy vision cones (range, FOV, close-range sense radius) |
| `F7` | God mode (enemies and lasers can't kill you; falling still does) |
| `F8` | Restart the match (host) |
| `1`–`0` | With the overlay open: teleport to section waypoints (`Shift` adds 10) |

The settings menu has an FPS counter for normal play.

## Performance notes

- About 530 draw calls and 105k triangles in the busiest views (the start line and the
  plaza), down from about 1,170. A render takes about 2.8 ms on the development
  machine, down from 6.1 ms.
- Static level geometry is merged per material and 150 m chunk.
- Enemies have three levels of detail. Within 115 m every jointed part is drawn and
  animated. Beyond that, one merged mesh of the rest pose stands in, with the eye,
  lens and searchlight still live. Beyond 330 m (a fogged two-pixel speck) they aren't
  drawn at all. Searchlights fade out before that, since they ignore fog.
- Glows on warning lights, lamps and skyline beacons, chimney smoke and the distant
  cloud banks are instanced camera-facing quads (`src/render/Billboards.ts`): four
  draw calls instead of about 230 sprites. Blinking runs on the GPU. Far glows fade
  into the fog instead of turning into pale blobs.
- All 48 laser beams are three instanced meshes (cores, glows, emitters). Zip cables are
  one merged mesh, and belts scroll a per-belt texture offset.
- Props are merged per material, particles use a single `Points` draw call, and all
  textures are generated procedurally at startup (no asset downloads).
- One shadow-casting directional light whose frustum follows the player. Quality
  presets adjust pixel ratio, shadows and shadow resolution.
- Enemy vision runs at 10–12 Hz with staggered timers, and raycasts walk a uniform grid.
- A height-fog shader patch fades everything below the course into haze, which
  sells the drop without extra geometry.

## Failure handling

The game shows a clear message when WebGL 2 isn't supported, when the server is
unavailable (with an offer to play offline instead), when a room doesn't exist, is
full or is already in progress, on a version mismatch, when the connection drops
(it reconnects on its own and offers "give up"), and when a player disconnects or leaves.
