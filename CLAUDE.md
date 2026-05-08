# Slipstream — project guide for Claude

3D third-person multiplayer arena shooter that runs in the browser. Client deploys to Vercel; multiplayer server is PartyKit (Cloudflare Durable Objects). Server is authoritative — clients send input intent, server simulates.

## Stack

- **pnpm monorepo**: `apps/client`, `apps/party`, `packages/shared`
- **TypeScript strict** end-to-end, ESM, `.js` extensions in TS source (Node ESM resolver — Vite doesn't care, the server build does)
- **Client**: Vite + React 18 + React Three Fiber + drei + Three.js + zustand + partysocket
- **Server**: PartyKit, single `Party.Server` class per room
- **Shared**: wire types + constants + the deterministic `applyMovement` function used by both sides

Tick rate 30 Hz, snapshot rate 20 Hz, input rate 30 Hz.

## Architecture

- **Server is the source of truth.** It runs `applyMovement` (from `@slipstream/shared`) on every input frame. Hit detection, health, ammo, kills/deaths all live server-side.
- **Client predicts locally** using the same `applyMovement`. On every snapshot the client drops acked inputs from its buffer, replays the rest from the server-confirmed state, and extrapolates a partial frame from the live input for the time since the last input was sent. No rubber-banding when math matches.
- **Position is the capsule's center**, not the feet. Floor clamp is `PLAYER.height / 2`. Visual capsule renders at the group origin (no extra Y lift). Eye height for raycasts is `position.y + height * 0.3`.
- **Remote players are time-interpolated** ~100ms behind the latest snapshot. Snapshot buffer is in `useGame.snapshots`.
- **Wire format**: `ClientMessage` / `ServerMessage` discriminated unions in `packages/shared/src/messages.ts`. Anything that crosses the wire MUST be defined there.

## Where things live

```
packages/shared/src/
  constants.ts   — PLAYER, MAP, WEAPON, NET, OBSTACLES (HOUSE_WALLS + scattered)
  sim.ts         — applyMovement, rayAABB, raycastObstacles
  state.ts       — PlayerState, GameSnapshot, GameEvent
  messages.ts    — wire types + encode/decode
apps/party/src/
  server.ts      — Party.Server, tick + snapshot loops, room lifecycle
  simulation.ts  — applyInput, tryFire, integrateIdle, maybeRespawn
  state.ts       — ServerPlayer, randomSpawn
apps/client/src/
  net/client.ts          — PartySocket wrapper, message dispatch
  store.ts               — Zustand: snapshots, events, conn state
  game/Scene.tsx         — R3F Canvas root
  game/Map.tsx           — arena geometry, renders OBSTACLES
  game/LocalPlayer.tsx   — input loop, prediction, sprint-demote-on-fire
  game/RemotePlayer.tsx  — snapshot interpolation
  game/Camera.tsx        — over-the-shoulder, spring-arm collision
  game/Character.tsx     — Mixamo character, anim state machine, gun
  game/local-state.ts    — singletons for input + predicted state
  game/input.ts          — pointer-lock + WASD + mouse handlers
  game/Tracers.tsx       — bullet tracers from shot events
public/models/Soldier.glb — Mixamo character + animations (Idle/Walk/Run/Fire/Reload/StrafeL/StrafeR)
```

## Build / dev

```
pnpm install
pnpm dev               # client on :5173, party on :1999, parallel
pnpm typecheck         # strict TS across the workspace
pnpm build
pnpm deploy:party      # PartyKit deploy (requires Adobe-free PartyKit login)
```

`vercel.json` at the repo root pins client builds for Vercel. Set `VITE_PARTYKIT_HOST` to the deployed PartyKit host.

## Gotchas (hard-won)

These are the things that have eaten hours. Read before changing related code.

1. **Mixamo bone world scale is ~0.001.** Bones come out of the FBX → Blender → glTF pipeline with a tiny cumulative scale. Don't `bone.add(child)` — the child renders at 0.001× size, invisible. Track the bone via `bone.getWorldPosition()` + `wrapper.worldToLocal()` per frame and skip rotation extraction (its `decompose()` inherits the bad scale).
2. **Mixamo animations carry root motion** in the `Hips.position` track unless downloaded with "In Place" enabled. Server is authoritative for position, so root motion fights every snapshot. `stripRootMotion()` in `Character.tsx` filters those tracks at runtime — don't remove it.
3. **Three.js auto-disables actions after `fadeOut` completes.** Specifically, `_updateWeight` sets `enabled = false` when the weight interpolant hits 0. A subsequent `fadeIn().play()` does NOT re-enable — the mixer forces effective weight to 0 and the bind pose (T-pose) blends through. **Always set `action.enabled = true` on every transition.** `applyClipMode()` does this.
4. **`integrateIdle` must gate on `TICK_MS * 1.5`.** Server's gravity-for-idle-players runs every tick, but if it fires for active players too it overwrites velocity to zero — client snapshots see velocity oscillating between sprint-speed and zero, animation state machine flickers Walk↔Idle on every snapshot.
5. **Don't add an `isRunning()` defensive check to the animation state machine.** It misfires for paused actions (Jump's frozen pose), continuously calls `fadeIn()`, weight permanently near 0 → T-pose blend. State machine should only act on actual state transitions.
6. **drei's `useGLTF` returns a shared scene.** Clone via `SkeletonUtils.clone(gltf.scene)` for each instance. Pass the **cloned object** to `useAnimations`, not a wrapper ref — the latter relies on tree traversal and binds intermittently.
7. **Sprint+fire is silently demoted to walk+fire** in two places: server `onMessage('input')` and client `LocalPlayer` input frame builder. Both must be kept in sync or prediction rubber-bands.
8. **Camera in tight spaces uses spring-arm with asymmetric damping.** Retract fast (lerp 0.6), return slow (lerp 0.1), 0.15m hysteresis. Camera radius (0.3m) inflates obstacle AABBs at ray-cast time so corners pull the camera in before clipping.
9. **Don't bump GLB version timestamps unless the file changed.** drei caches by URL — adding `?v=${Date.now()}` forces re-downloads of multi-MB files for every player on every reload.
10. **HMR debt**. After many hot reloads (especially across `Character.tsx`), WebGL contexts get exhausted and Vite's optimizer cache desyncs. If errors look weird and reloads don't help, restart the dev server. Symptoms: Character component throws on mount, `Context Lost` log spam.

## Conventions

- **Wire types only** in `@slipstream/shared`. Server `ServerPlayer` extends `PlayerState` privately; the public wire shape is `PlayerState`.
- **Constants only** in `@slipstream/shared/constants` — even when used only on one side. Keeps tuning in one file.
- **`stripServerOnly`** in `server.ts` strips fields like `grounded`, `pendingInputSeq`, `lastIntegratedAt` before broadcasting. Client derives these if it needs them.
- **Server tunables** that affect prediction must be in shared constants (gravity, jump speed, etc.). Server-only state (timers, room id) stays in `apps/party`.
- **No NaN math.** Clamp input axes (`forward`, `right`) to [-1, 1] before integrating. Clamp `dtMs` to ≤100ms before division.
- **No comments narrating WHAT.** Names do that. Comments only for non-obvious WHY (a gotcha, an invariant, a workaround).

## Asset pipeline (Mixamo character)

To swap or add animations:

1. Mixamo → download character FBX with skin (T-pose) into `Characters/`. Animations → FBX without skin, **In Place ✓**, into `Animations/Slim Shooter Pack/`.
2. Edit `/tmp/merge_mixamo.py`: set `CHARACTER_PATH`, add to `ANIMATIONS` list (clip name → FBX path).
3. Run merge:
   ```
   /Applications/Blender.app/Contents/MacOS/Blender --background --python /tmp/merge_mixamo.py
   ```
4. Compress (Blender output is usually 100MB+ from embedded textures):
   ```
   cp apps/client/public/models/Soldier.glb /tmp/Soldier_uncompressed.glb
   npx --yes @gltf-transform/cli resize /tmp/Soldier_uncompressed.glb /tmp/_step1.glb --width 1024 --height 1024
   npx --yes @gltf-transform/cli webp /tmp/_step1.glb apps/client/public/models/Soldier.glb
   ```
   Don't use `gltf-transform optimize` — it adds meshopt compression which Three.js's default `GLTFLoader` can't decode without `MeshoptDecoder` registration.
5. If clip names changed, update `CLIP_NAMES` at the top of `Character.tsx`.

`Animations/`, `Characters/`, and `*.fbx` are gitignored — keep sources local, only the merged Soldier.glb ships.

## State of the art (open polish items)

Things that are wired but not yet polished. Pick these up in order of player-visibility.

- **Reload state**: clip exists in GLB, R-key sends `input.reload`, server runs `WEAPON.reloadMs` timer, but state machine never enters Reload (no event triggers it). Need to wire a "reload started" event from server.
- **Strafe**: `StrafeL` / `StrafeR` clips exist; state machine doesn't pick them. Would need direction-aware locomotion (sideways velocity > forward velocity → Strafe).
- **Real Jump clip**: `Jump` state currently maps to `Run` frozen mid-stride (`JUMP_POSE_TIME = 0.35`). Replace with a Mixamo `Jump` clip and remove the freeze code in `applyClipMode`.
- **Gun tracks hand rotation**: gun follows hand position but its rotation is fixed at `[0, π, 0]`. Need to extract rotation from `bone.matrixWorld` after scale-normalization.
- **Lag compensation**: server raycasts hits against current positions; should rewind to time = `now - shooter.RTT/2 - interpolationDelay`.
- **Muzzle flash + recoil on the held gun**: was wired in an earlier iteration with the floating gun, removed during the bone-attached rewrite. Re-add in `Character.tsx`'s `useFrame` after the gun position update.
- **Multi-character**: `Ch35_nonPBR.fbx` is downloaded but unused. Need character-id-per-player in the wire format.

## What NOT to do

- Don't commit `Animations/` or `Characters/` source FBX files — gitignored, they're 100s of MB.
- Don't run destructive git operations (`reset --hard`, `push --force`) without explicit user authorization.
- Don't add features beyond what was asked. Bug fixes don't need surrounding cleanup; one-shot operations don't need helpers.
- Don't add comments narrating what the code does. Names + tests do that.
- Don't introduce backwards-compat shims for code paths the user is fine changing.
- Don't `git add -A` blindly after generating large artifacts — check `git status` first to catch the next 246MB FBX commit before it lands.
