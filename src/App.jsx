/**
 * Jenga — App.jsx
 * Firebase Realtime Database multiplayer · Rapier physics · Free drag
 *
 * Firebase schema:
 *   rooms/{code}/
 *     current  : "playerId"           ← whose turn it is
 *     players  : { id: timestamp }    ← joined players (null = left)
 *     removed  : { "b3-1": true }     ← pulled blocks
 *     createdAt: number
 *
 * IMPORTANT: Go to Firebase Console → Realtime Database → Rules and set:
 *   { "rules": { ".read": true, ".write": true } }
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider } from "@react-three/rapier";
import { ref, set, onValue, update } from "firebase/database";
import { db } from "./firebase";
import * as THREE from "three";

// ─── Constants ────────────────────────────────────────────────────────────────
const BW = 1.05;   // block length
const BH = 0.30;   // block height
const BD = 0.34;   // block depth  (3 × BD + 2 × ROW_GAP ≈ BW)

const STACK_GAP = 0.001;
const ROW_GAP   = 0.003;
const LEVELS    = 18;
const ROOM_LEN  = 4;
const TURN_SEC  = 30;

// Physics — heavy wood, zero bounce
const GRAVITY     = -12;
const FRICTION    = 0.95;
const RESTITUTION = 0.0;
const LIN_DAMP    = 5.5;
const ANG_DAMP    = 6.0;
const MASS        = 1.8;

// Drag spring
const SPRING_K  = 320;
const MAX_FORCE = 28;
const DRAG_DAMP = 16;

// Stagger thaw so tower settles bottom-up, not all at once
const BASE_THAW    = 700;
const PER_LEVEL    = 80;
const TOTAL_SETTLE = BASE_THAW + LEVELS * PER_LEVEL + 600;

// ─── Build tower ──────────────────────────────────────────────────────────────
function buildBlocks() {
  const out = [];
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const alongX = lvl % 2 === 0;
    const y = BH / 2 + lvl * (BH + STACK_GAP);
    for (let col = 0; col < 3; col++) {
      const off = (col - 1) * (BD + ROW_GAP);
      out.push({
        id:      `b${lvl}-${col}`,
        level:   lvl,
        removed: false,
        px: alongX ? 0   : off,  py: y,  pz: alongX ? off : 0,
        ry: alongX ? 0   : Math.PI / 2,
        // original X/Z — used to measure pull distance
        ox: alongX ? 0   : off,
        oz: alongX ? off : 0,
      });
    }
  }
  return out;
}

const makeCode = () => {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: ROOM_LEN }, () => c[~~(Math.random() * c.length)]).join("");
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── Gyro hook ────────────────────────────────────────────────────────────────
function useGyro() {
  const [stab, setStab]      = useState(100);
  const [needsBtn, setNeeds] = useState(false);
  const prev = useRef({ a: 0, b: 0, g: 0 });

  // Slow recovery while phone is still
  useEffect(() => {
    const t = setInterval(() => setStab(s => clamp(s + 0.5, 0, 100)), 80);
    return () => clearInterval(t);
  }, []);

  const attach = useCallback(() => {
    const h = (e) => {
      const a = e.rotationRate?.alpha ?? 0;
      const b = e.rotationRate?.beta  ?? 0;
      const g = e.rotationRate?.gamma ?? 0;
      const d = Math.abs(a - prev.current.a)
              + Math.abs(b - prev.current.b)
              + Math.abs(g - prev.current.g);
      if (d > 0.4) setStab(s => clamp(s - d * 0.09, 0, 100));
      prev.current = { a, b, g };
    };
    window.addEventListener("devicemotion", h, true);
    return () => window.removeEventListener("devicemotion", h, true);
  }, []);

  useEffect(() => {
    if (typeof DeviceMotionEvent === "undefined") return;
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      // iOS — must wait for user gesture
      setNeeds(true);
    } else {
      // Android / desktop — start immediately
      return attach();
    }
  }, []); // eslint-disable-line

  const requestGyro = useCallback(async () => {
    try {
      if ((await DeviceMotionEvent.requestPermission()) === "granted") {
        attach();
        setNeeds(false);
      }
    } catch {}
  }, [attach]);

  return { stab, needsBtn, requestGyro };
}

// ─── Firebase room hook ───────────────────────────────────────────────────────
/**
 * All Firebase reads/writes go through here.
 *
 * Firebase drives:
 *   - whose turn it is       (current)
 *   - which blocks are gone  (removed)
 *   - who's in the room      (players)
 *
 * The local timer is purely visual — it resets every time Firebase
 * pushes a new `current`, so clients stay in sync without hammering
 * Firebase with a tick every second.
 */
function useFirebaseRoom(myId) {
  const unsubRef    = useRef(null);
  const roomDataRef = useRef(null); // latest snapshot from Firebase

  const [roomCode,     setRoomCode]     = useState("");
  const [status,       setStatus]       = useState("local");
  const [currentTurn,  setCurrentTurn]  = useState(null);
  const [playerCount,  setPlayerCount]  = useState(0);
  const [removedIds,   setRemovedIds]   = useState([]);

  // Called whenever Firebase pushes new data
  const applySnapshot = useCallback((data) => {
    roomDataRef.current = data;
    if (data.current) setCurrentTurn(data.current);
    const count = data.players
      ? Object.values(data.players).filter(Boolean).length
      : 0;
    setPlayerCount(count);
    if (data.removed) setRemovedIds(Object.keys(data.removed));
    else setRemovedIds([]);
  }, []);

  const subscribe = useCallback((code) => {
    // Tear down previous listener if any
    unsubRef.current?.();
    const r = ref(db, `rooms/${code}`);
    setStatus("connecting");

    const unsub = onValue(r, (snap) => {
      const data = snap.val();
      if (!data) { setStatus("not found"); return; }
      setStatus("online");
      applySnapshot(data);
    });

    unsubRef.current = unsub;
  }, [applySnapshot]);

  // ── Create a brand-new room ──
  const createRoom = useCallback((code) => {
    const r = ref(db, `rooms/${code}`);
    set(r, {
      current:   myId,
      players:   { [myId]: Date.now() },
      removed:   {},
      createdAt: Date.now(),
    });
    setRoomCode(code);
    setCurrentTurn(myId);
    setRemovedIds([]);
    setPlayerCount(1);
    subscribe(code);
  }, [myId, subscribe]);

  // ── Join an existing room ──
  const joinRoom = useCallback((code) => {
    // Add ourselves to the players list in Firebase
    update(ref(db, `rooms/${code}`), {
      [`players/${myId}`]: Date.now(),
    });
    setRoomCode(code);
    subscribe(code);
  }, [myId, subscribe]);

  // ── Leave room ──
  const leaveRoom = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    if (roomCode && myId) {
      // Mark ourselves as null (not fully delete, keeps turn order intact)
      update(ref(db, `rooms/${roomCode}`), {
        [`players/${myId}`]: null,
      });
    }
    setRoomCode("");
    setStatus("local");
    setCurrentTurn(null);
    setPlayerCount(0);
    setRemovedIds([]);
    roomDataRef.current = null;
  }, [roomCode, myId]);

  // ── Called when the current player pulls a block ──
  const emitPulled = useCallback((blockId) => {
    const data = roomDataRef.current;
    if (!data || !roomCode) return;

    // Work out who goes next
    const players = data.players
      ? Object.entries(data.players)
          .filter(([, v]) => v != null)
          .sort(([, a], [, b]) => a - b)   // sort by join timestamp
          .map(([id]) => id)
      : [myId];

    const idx      = players.indexOf(data.current ?? myId);
    const nextId   = players[(idx + 1) % players.length] ?? myId;

    update(ref(db, `rooms/${roomCode}`), {
      [`removed/${blockId}`]: true,
      current: nextId,
    });
  }, [roomCode, myId]);

  // Cleanup on unmount
  useEffect(() => () => unsubRef.current?.(), []);

  return {
    roomCode, status, currentTurn, playerCount, removedIds,
    createRoom, joinRoom, leaveRoom, emitPulled,
  };
}

// ─── Block component ──────────────────────────────────────────────────────────
/**
 * Each block:
 *  - Registers its RigidBody ref in the shared rbRefs map (for DragController)
 *  - Tags its mesh with userData.blockId (for raycaster lookup)
 *  - Starts kinematic, thaws to dynamic after thawDelay ms
 */
const Block = React.memo(function Block({ block, rbRefs, thawDelay }) {
  const rbRef   = useRef(null);
  const meshRef = useRef(null);

  // Register in shared map so DragController can find us
  useEffect(() => {
    if (rbRef.current) rbRefs.current.set(block.id, rbRef.current);
    return () => rbRefs.current.delete(block.id);
  }, []); // eslint-disable-line — intentionally runs once

  // Tag mesh so raycaster can identify which block was hit
  useEffect(() => {
    if (meshRef.current) meshRef.current.userData.blockId = block.id;
  }, []); // eslint-disable-line

  // Thaw: just a plain setTimeout — no performance.now() math
  useEffect(() => {
    const t = setTimeout(() => rbRef.current?.setBodyType(0), thawDelay);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line

  if (block.removed) return null;

  return (
    <RigidBody
      ref={rbRef}
      position={[block.px, block.py, block.pz]}
      rotation={[0, block.ry, 0]}
      type="kinematicPosition"
      colliders={false}
      mass={MASS}
      friction={FRICTION}
      restitution={RESTITUTION}
      linearDamping={LIN_DAMP}
      angularDamping={ANG_DAMP}
      canSleep
    >
      <CuboidCollider
        args={[BW / 2 - 0.002, BH / 2 - 0.002, BD / 2 - 0.002]}
        friction={FRICTION}
        restitution={RESTITUTION}
      />
      <mesh ref={meshRef} castShadow receiveShadow>
        <boxGeometry args={[BW, BH, BD]} />
        <meshStandardMaterial color="#c47a3a" roughness={0.88} metalness={0.03} />
      </mesh>
    </RigidBody>
  );
});

// ─── Drag controller ──────────────────────────────────────────────────────────
/**
 * Pointer/touch down  → raycast into scene → find mesh by userData.blockId
 *                     → wake RigidBody → build horizontal drag plane
 * Every frame        → project pointer onto plane → apply spring force (X + Z free)
 * Pointer up         → measure 2D distance from origin → if > 62% of BW = pulled
 */
function DragController({ rbRefs, blocks, settled, myTurn, onPulled, setOrbitEnabled }) {
  const { camera, gl, scene } = useThree();

  const drag     = useRef(null);
  const ptr      = useRef(new THREE.Vector2());
  const ray      = useRef(new THREE.Raycaster());
  const hitPt    = useRef(new THREE.Vector3());
  const blockMap = useRef({});

  // Keep fast id→block lookup up to date
  useEffect(() => {
    blockMap.current = Object.fromEntries(blocks.map(b => [b.id, b]));
  }, [blocks]);

  const toNDC = useCallback((cx, cy) => {
    const r = gl.domElement.getBoundingClientRect();
    ptr.current.set(
      ((cx - r.left) / r.width)  *  2 - 1,
      ((cy - r.top)  / r.height) * -2 + 1,
    );
  }, [gl]);

  const onDown = useCallback((e) => {
    if (!myTurn || !settled) return;

    const cx = e.touches?.[0]?.clientX ?? e.clientX;
    const cy = e.touches?.[0]?.clientY ?? e.clientY;
    toNDC(cx, cy);

    ray.current.setFromCamera(ptr.current, camera);

    // Collect all tagged meshes that belong to live blocks
    const meshes = [];
    scene.traverse(obj => {
      if (obj.isMesh && obj.userData.blockId) {
        const b = blockMap.current[obj.userData.blockId];
        if (b && !b.removed) meshes.push(obj);
      }
    });

    const hits = ray.current.intersectObjects(meshes, false);
    if (!hits.length) return;

    const blockId = hits[0].object.userData.blockId;
    const block   = blockMap.current[blockId];
    const rb      = rbRefs.current.get(blockId);
    if (!block || !rb) return;

    // Wake up and make dynamic so forces affect it
    rb.wakeUp();
    rb.setBodyType(0);

    // Build a horizontal plane at the block's Y, facing the camera
    const pos  = rb.translation();
    const norm = new THREE.Vector3(
      camera.position.x - pos.x, 0, camera.position.z - pos.z,
    ).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      norm, new THREE.Vector3(pos.x, pos.y, pos.z),
    );

    drag.current = { blockId, rb, ox: block.ox, oz: block.oz, plane };
    setOrbitEnabled(false); // stop camera spinning while dragging
    e.preventDefault?.();
  }, [myTurn, settled, camera, gl, scene, rbRefs, toNDC, setOrbitEnabled]);

  const onMove = useCallback((e) => {
    if (!drag.current) return;
    const cx = e.touches?.[0]?.clientX ?? e.clientX;
    const cy = e.touches?.[0]?.clientY ?? e.clientY;
    toNDC(cx, cy);
    e.preventDefault?.();
  }, [toNDC]);

  const onUp = useCallback(() => {
    if (!drag.current) return;
    const { blockId, rb, ox, oz } = drag.current;
    drag.current = null;
    setOrbitEnabled(true);
    if (!rb) return;

    const pos  = rb.translation();
    const dx   = pos.x - ox;
    const dz   = pos.z - oz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > BW * 0.62) onPulled(blockId);
  }, [onPulled, setOrbitEnabled]);

  useEffect(() => {
    const el   = gl.domElement;
    const opts = { passive: false };
    el.addEventListener("pointerdown",   onDown, opts);
    el.addEventListener("pointermove",   onMove, opts);
    el.addEventListener("pointerup",     onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("touchstart",    onDown, opts);
    el.addEventListener("touchmove",     onMove, opts);
    el.addEventListener("touchend",      onUp);
    return () => {
      el.removeEventListener("pointerdown",   onDown);
      el.removeEventListener("pointermove",   onMove);
      el.removeEventListener("pointerup",     onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("touchstart",    onDown);
      el.removeEventListener("touchmove",     onMove);
      el.removeEventListener("touchend",      onUp);
    };
  }, [gl, onDown, onMove, onUp]);

  // Spring impulse applied every frame while dragging
  useFrame(() => {
    if (!drag.current) return;
    const { rb, plane } = drag.current;

    ray.current.setFromCamera(ptr.current, camera);
    if (!ray.current.ray.intersectPlane(plane, hitPt.current)) return;

    const pos = rb.translation();
    const vel = rb.linvel();

    // Free movement in X and Z — friction from neighbours naturally resists
    const dx = hitPt.current.x - pos.x;
    const dz = hitPt.current.z - pos.z;

    let fx = dx * SPRING_K - vel.x * DRAG_DAMP;
    let fz = dz * SPRING_K - vel.z * DRAG_DAMP;
    const fy = -vel.y * 12; // resist vertical drift

    const mag = Math.sqrt(fx * fx + fz * fz);
    if (mag > MAX_FORCE) { const s = MAX_FORCE / mag; fx *= s; fz *= s; }

    rb.applyImpulse({ x: fx * 0.016, y: fy * 0.016, z: fz * 0.016 }, true);
    rb.wakeUp();
  });

  return null;
}

// ─── Floor ────────────────────────────────────────────────────────────────────
function Table() {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.01, 0]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#1a0e06" roughness={0.97} />
      </mesh>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[20, 0.1, 20]} position={[0, -0.12, 0]}
          friction={0.98} restitution={0.0}
        />
      </RigidBody>
    </>
  );
}

// ─── 3-D scene ────────────────────────────────────────────────────────────────
function Scene({
  blocks, rbRefs, thawDelays, settled,
  myTurn, onPulled, orbitEnabled, setOrbitEnabled,
}) {
  const ctrlRef = useRef(null);
  useEffect(() => {
    if (ctrlRef.current) ctrlRef.current.enabled = orbitEnabled;
  }, [orbitEnabled]);

  const topY = BH / 2 + LEVELS * (BH + STACK_GAP) + 0.6;

  return (
    <>
      <color attach="background" args={["#0d0b08"]} />
      <fog   attach="fog"        args={["#0d0b08", 14, 40]} />

      <ambientLight intensity={0.65} />
      <directionalLight
        position={[9, 16, 7]} intensity={2.7} castShadow
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-near={0.5}   shadow-camera-far={50}
        shadow-camera-left={-8}    shadow-camera-right={8}
        shadow-camera-top={12}     shadow-camera-bottom={-3}
      />
      <pointLight position={[-4, 6, -5]} intensity={0.4} color="#ffd08a" />
      <pointLight position={[ 5, 2,  4]} intensity={0.2} color="#fff0d0" />

      <Physics
        gravity={[0, GRAVITY, 0]}
        timeStep={1 / 60}
        colliders={false}
        numSolverIterations={14}
        numAdditionalFrictionIterations={8}
      >
        <Table />
        {blocks.map(b => (
          <Block
            key={b.id}
            block={b}
            rbRefs={rbRefs}
            thawDelay={thawDelays[b.level]}
          />
        ))}
        <DragController
          rbRefs={rbRefs}
          blocks={blocks}
          settled={settled}
          myTurn={myTurn}
          onPulled={onPulled}
          setOrbitEnabled={setOrbitEnabled}
        />
      </Physics>

      <Text
        position={[0, topY, 0]}
        fontSize={0.25}
        color="#f0d090"
        anchorX="center"
      >
        JENGA
      </Text>

      <OrbitControls
        ref={ctrlRef}
        enablePan={false}
        minDistance={5}
        maxDistance={22}
        maxPolarAngle={Math.PI / 2.05}
        makeDefault
      />
    </>
  );
}

// ─── HUD (bottom-right) ───────────────────────────────────────────────────────
function HUD({ stab, needsBtn, requestGyro, myTurn, timeLeft, settled, currentTurn, myId }) {
  const pct   = Math.round(stab);
  const color = pct > 66 ? "#4ade80" : pct > 33 ? "#fbbf24" : "#f87171";

  const turnLabel = myTurn
    ? "Your turn"
    : currentTurn
      ? `${currentTurn.slice(0, 6)}…`
      : "Waiting…";

  const hintText = !settled
    ? "Tower settling…"
    : myTurn
      ? "Drag any block in any direction."
      : "Wait for your turn.";

  return (
    <div style={hud}>
      <HRow label="Turn"      val={turnLabel}   col={myTurn ? "#4ade80" : "#aaa"} />
      <HRow label="Timer"     val={`${timeLeft}s`} col={timeLeft < 8 ? "#f87171" : "#fff"} />
      <HRow label="Stability" val={`${pct}%`}   col={color} />
      <div style={bar}><div style={{ ...barF, width: `${pct}%`, background: color }} /></div>
      {needsBtn && (
        <button style={gyroBtn} onClick={requestGyro}>📱 Enable gyro (iOS)</button>
      )}
      <div style={hint}>{hintText}</div>
    </div>
  );
}
const HRow = ({ label, val, col }) => (
  <div style={hrow}><span style={hl}>{label}</span><span style={{ ...hv, color: col }}>{val}</span></div>
);

// ─── Control panel (top-left) ─────────────────────────────────────────────────
function Panel({ roomCode, onCreate, onJoin, onLeave, status, myId, playerCount }) {
  const [joinText, setJoinText] = useState("");
  const [err, setErr]           = useState("");

  const handleJoin = () => {
    const code = joinText.trim().toUpperCase();
    if (code.length !== ROOM_LEN) { setErr(`Code must be ${ROOM_LEN} characters`); return; }
    setErr("");
    onJoin(code);
  };

  const inRoom = Boolean(roomCode);

  return (
    <div style={panel}>
      <div style={ptitle}>Jenga</div>
      <div style={psub}>Worldwide · Firebase · Real Physics</div>

      {!inRoom ? (
        <div style={sec}>
          <button style={btn} onClick={onCreate}>Create Room</button>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={joinText}
              onChange={e => { setJoinText(e.target.value.toUpperCase().slice(0, ROOM_LEN)); setErr(""); }}
              onKeyDown={e => e.key === "Enter" && handleJoin()}
              placeholder="ABCD" maxLength={ROOM_LEN} style={inp}
            />
            <button style={btn} onClick={handleJoin}>Join</button>
          </div>
          {err && <div style={{ color: "#f87171", fontSize: 12 }}>{err}</div>}
        </div>
      ) : (
        <div style={sec}>
          <div style={sr}><span style={dim}>Room</span>
            <b style={{ letterSpacing: "0.18em", color: "#f0d090", fontSize: 18 }}>{roomCode}</b>
          </div>
          <div style={sr}><span style={dim}>Status</span>
            <b style={{ color: status === "online" ? "#4ade80" : "#fbbf24" }}>{status}</b>
          </div>
          <div style={sr}><span style={dim}>Players</span><b>{playerCount}</b></div>
          <div style={sr}><span style={dim}>Your ID</span>
            <b style={{ fontFamily: "monospace", fontSize: 12 }}>{myId.slice(0, 8)}</b>
          </div>
          <button style={{ ...btn, background: "#3f1010", marginTop: 4 }} onClick={onLeave}>
            Leave room
          </button>
        </div>
      )}

      <div style={hlp}>
        {inRoom
          ? "Share the code above with anyone worldwide to play together."
          : "Create a room to get a code, or enter a friend's code to join."}
      </div>
    </div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
export default function App() {
  // Stable player ID for this session (regenerated on page reload)
  const [myId] = useState(() => Math.random().toString(36).slice(2, 10));

  const [blocks, setBlocks]             = useState(buildBlocks);
  const [settled, setSettled]           = useState(false);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [timeLeft, setTimeLeft]         = useState(TURN_SEC);

  const rbRefs = useRef(new Map());

  // Precompute thaw delays (bottom level first)
  const thawDelays = useMemo(() => {
    const d = {};
    for (let lvl = 0; lvl < LEVELS; lvl++) d[lvl] = BASE_THAW + lvl * PER_LEVEL;
    return d;
  }, []);

  const startSettle = useCallback(() => {
    setSettled(false);
    setTimeout(() => setSettled(true), TOTAL_SETTLE);
  }, []);

  // First settle on mount
  useEffect(() => { startSettle(); }, []); // eslint-disable-line

  const { stab, needsBtn, requestGyro } = useGyro();

  // ── Firebase ──
  const {
    roomCode, status, currentTurn, playerCount, removedIds,
    createRoom, joinRoom, leaveRoom, emitPulled,
  } = useFirebaseRoom(myId);

  // Apply removed blocks from Firebase to local state
  useEffect(() => {
    if (!removedIds.length) return;
    setBlocks(prev => prev.map(b =>
      removedIds.includes(b.id) ? { ...b, removed: true } : b,
    ));
  }, [removedIds]);

  // myTurn: true when it's my turn, OR when playing solo (no room)
  const myTurn = !roomCode || currentTurn === myId;

  // ── Local timer — purely visual, resets when Firebase changes currentTurn ──
  const prevTurnRef = useRef(currentTurn);
  useEffect(() => {
    if (prevTurnRef.current !== currentTurn) {
      prevTurnRef.current = currentTurn;
      setTimeLeft(TURN_SEC); // reset on every turn change
    }
  }, [currentTurn]);

  useEffect(() => {
    const t = setInterval(() => {
      setTimeLeft(p => (p <= 1 ? TURN_SEC : p - 1));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ── Block pulled ──
  const onPulled = useCallback((blockId) => {
    // Optimistic local update so it feels instant
    setBlocks(p => p.map(b => b.id === blockId ? { ...b, removed: true } : b));

    if (roomCode) {
      // Firebase drives the turn change for all clients
      emitPulled(blockId);
    } else {
      // Solo mode — just reset timer
      setTimeLeft(TURN_SEC);
    }
  }, [roomCode, emitPulled]);

  // ── Create room ──
  const onCreate = useCallback(() => {
    const code = makeCode();
    setBlocks(buildBlocks());
    startSettle();
    createRoom(code);
  }, [createRoom, startSettle]);

  // ── Join room ──
  const onJoin = useCallback((code) => {
    setBlocks(buildBlocks()); // fresh local tower; removed blocks applied via Firebase
    startSettle();
    joinRoom(code);
  }, [joinRoom, startSettle]);

  // ── Leave room ──
  const onLeave = useCallback(() => {
    leaveRoom();
    setBlocks(buildBlocks());
    startSettle();
    setTimeLeft(TURN_SEC);
  }, [leaveRoom, startSettle]);

  return (
    <div style={root}>
      <Panel
        roomCode={roomCode}
        onCreate={onCreate}
        onJoin={onJoin}
        onLeave={onLeave}
        status={status}
        myId={myId}
        playerCount={playerCount}
      />

      <Canvas
        shadows
        camera={{ position: [7, 9.5, 9], fov: 44 }}
        style={{ position: "absolute", inset: 0 }}
        gl={{ antialias: true }}
      >
        <Scene
          blocks={blocks}
          rbRefs={rbRefs}
          thawDelays={thawDelays}
          settled={settled}
          myTurn={myTurn}
          onPulled={onPulled}
          orbitEnabled={orbitEnabled}
          setOrbitEnabled={setOrbitEnabled}
        />
      </Canvas>

      <HUD
        stab={stab}
        needsBtn={needsBtn}
        requestGyro={requestGyro}
        myTurn={myTurn}
        timeLeft={timeLeft}
        settled={settled}
        currentTurn={currentTurn}
        myId={myId}
      />

      {/* Settle overlay */}
      {!settled && (
        <div style={ovl}>
          <div style={ovlBox}>
            <div style={ovlTitle}>Stacking blocks…</div>
            <div style={ovlTrack}>
              <div style={{ ...ovlFill, animationDuration: `${TOTAL_SETTLE / 1000}s` }} />
            </div>
            <div style={{ fontSize: 12, opacity: 0.4, marginTop: 8 }}>Physics settling</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const root  = { width:"100vw", height:"100vh", overflow:"hidden", background:"#0d0b08", fontFamily:"'Inter',system-ui,sans-serif" };
const glass = { background:"rgba(10,8,5,0.84)", backdropFilter:"blur(18px)", WebkitBackdropFilter:"blur(18px)", borderRadius:16, border:"1px solid rgba(255,255,255,0.08)", boxShadow:"0 10px 40px rgba(0,0,0,0.6)", color:"#fff", padding:16 };

const panel  = { ...glass, position:"absolute", top:16, left:16, zIndex:10, width:268 };
const ptitle = { fontWeight:900, fontSize:22, letterSpacing:"0.04em", marginBottom:2, color:"#f0d090" };
const psub   = { fontSize:12, opacity:0.45, marginBottom:14, letterSpacing:"0.07em" };
const sec    = { display:"grid", gap:8, marginBottom:12, padding:10, borderRadius:12, background:"rgba(255,255,255,0.04)" };
const btn    = { border:0, borderRadius:10, padding:"10px 14px", background:"#7a4010", color:"#fff", fontWeight:800, fontSize:13, cursor:"pointer" };
const inp    = { flex:1, minWidth:0, border:"1px solid rgba(255,255,255,0.1)", outline:"none", borderRadius:10, padding:"10px 12px", fontWeight:800, letterSpacing:"0.18em", background:"rgba(255,255,255,0.07)", color:"#fff", fontSize:15 };
const sr     = { display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:13 };
const dim    = { opacity:0.5 };
const hlp    = { fontSize:12, opacity:0.4, lineHeight:1.55, marginTop:4 };

const hud    = { ...glass, position:"absolute", bottom:16, right:16, zIndex:10, width:228 };
const hrow   = { display:"flex", justifyContent:"space-between", marginBottom:8 };
const hl     = { fontSize:12, opacity:0.5 };
const hv     = { fontWeight:900, fontSize:15 };
const bar    = { height:6, borderRadius:4, background:"rgba(255,255,255,0.08)", overflow:"hidden", marginBottom:10 };
const barF   = { height:"100%", borderRadius:4, transition:"width 0.22s ease, background 0.4s ease" };
const hint   = { fontSize:11, opacity:0.42, lineHeight:1.5 };
const gyroBtn = { width:"100%", border:0, borderRadius:10, padding:"9px 0", background:"#1d4ed8", color:"#fff", fontWeight:800, fontSize:13, cursor:"pointer", marginBottom:10 };

const ovl      = { position:"absolute", inset:0, zIndex:20, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(0,0,0,0.65)", backdropFilter:"blur(5px)" };
const ovlBox   = { ...glass, textAlign:"center", width:220 };
const ovlTitle = { fontWeight:800, fontSize:17, color:"#f0d090", marginBottom:14 };
const ovlTrack = { height:5, borderRadius:4, background:"rgba(255,255,255,0.1)", overflow:"hidden" };
const ovlFill  = { height:"100%", borderRadius:4, background:"#7a4010", animation:"grow linear forwards" };