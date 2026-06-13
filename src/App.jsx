/**
 * Jenga — App.jsx
 *
 * Changes vs previous version:
 *  - socket.io replaced with native WebSocket (works with Cloudflare Workers)
 *  - Drag is now FREE (X + Z simultaneously) — no single-axis lock
 *  - Gravity increased to -22 (blocks feel heavy and satisfying)
 *  - Pull detection uses 2D distance, not single-axis
 *  - OrbitControls disabled while dragging so finger doesn't spin the camera
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider } from "@react-three/rapier";
import * as THREE from "three";

// ─── Dimensions ───────────────────────────────────────────────────────────────
const BW = 1.05;
const BH = 0.30;
const BD = 0.34;
const STACK_GAP = 0.001;
const ROW_GAP   = 0.003;
const LEVELS    = 18;
const ROOM_LEN  = 4;
const TURN_SEC  = 30;

// Physics — heavy, zero bounce, lots of damping
const GRAVITY     = -22;   // ← more than doubled from -9.81
const FRICTION    = 0.95;
const RESTITUTION = 0.0;
const LIN_DAMP    = 5.5;
const ANG_DAMP    = 6.0;
const MASS        = 1.8;   // heavier blocks

// Drag spring — free 2D movement (X + Z)
const SPRING_K  = 320;
const MAX_FORCE = 28;
const DRAG_DAMP = 16;

// Thaw timing
const BASE_THAW    = 600;
const PER_LEVEL    = 75;
const TOTAL_SETTLE = BASE_THAW + LEVELS * PER_LEVEL + 500;

// ─── Tower layout ─────────────────────────────────────────────────────────────
function buildBlocks() {
  const out = [];
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const alongX = lvl % 2 === 0;
    const y = BH / 2 + lvl * (BH + STACK_GAP);
    for (let col = 0; col < 3; col++) {
      const off = (col - 1) * (BD + ROW_GAP);
      out.push({
        id: `b${lvl}-${col}`,
        level: lvl,
        removed: false,
        px: alongX ? 0   : off,  py: y,  pz: alongX ? off : 0,
        ry: alongX ? 0 : Math.PI / 2,
        // origin — used to measure how far it has moved
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
  const [stab, setStab]       = useState(100);
  const [needsBtn, setNeeds]  = useState(false);
  const [active, setActive]   = useState(false);
  const prev = useRef({ a: 0, b: 0, g: 0 });

  // Recovery while still
  useEffect(() => {
    const t = setInterval(() => setStab(s => clamp(s + 0.5, 0, 100)), 80);
    return () => clearInterval(t);
  }, []);

  const attach = useCallback(() => {
    const handler = (e) => {
      const a = e.rotationRate?.alpha ?? 0;
      const b = e.rotationRate?.beta  ?? 0;
      const g = e.rotationRate?.gamma ?? 0;
      const d = Math.abs(a - prev.current.a)
              + Math.abs(b - prev.current.b)
              + Math.abs(g - prev.current.g);
      if (d > 0.4) setStab(s => clamp(s - d * 0.09, 0, 100));
      prev.current = { a, b, g };
    };
    window.addEventListener("devicemotion", handler, true);
    setActive(true);
    return () => window.removeEventListener("devicemotion", handler, true);
  }, []);

  useEffect(() => {
    if (typeof DeviceMotionEvent === "undefined") return;
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      // iOS — show button
      setNeeds(true);
    } else {
      // Android/desktop — attach immediately
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

  return { stab, active, needsBtn, requestGyro };
}

// ─── WebSocket hook (replaces socket.io) ─────────────────────────────────────
/**
 * Native WebSocket — connects to Cloudflare Worker at:
 *   wss://<worker-url>/room/<CODE>
 *
 * Messages are plain JSON: { type, ...data }
 */
function useWS(onMessage) {
  const wsRef    = useRef(null);
  const pingRef  = useRef(null);
  const [status, setStatus] = useState("local");

  const connect = useCallback((roomCode) => {
    // Close any existing connection
    wsRef.current?.close();
    clearInterval(pingRef.current);

    const base = import.meta.env.VITE_SERVER_URL;
    if (!base) { setStatus("local"); return; }

    // Convert http(s) → ws(s)
    const wsUrl = base.replace(/^https/, "wss").replace(/^http/, "ws");
    const url   = `${wsUrl}/room/${roomCode}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus("connecting…");

    ws.onopen = () => {
      setStatus("online");
      // Keep-alive ping every 20s (Cloudflare closes idle WS after 100s)
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 20000);
    };

    ws.onclose = () => {
      setStatus("offline");
      clearInterval(pingRef.current);
    };

    ws.onerror = () => setStatus("error");

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== "pong") onMessage?.(msg.type, msg);
      } catch {}
    };
  }, [onMessage]);

  const emit = useCallback((type, data = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, ...data }));
    }
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    clearInterval(pingRef.current);
    setStatus("local");
  }, []);

  useEffect(() => () => { wsRef.current?.close(); clearInterval(pingRef.current); }, []);

  return { emit, status, connect, disconnect };
}

// ─── Block component ──────────────────────────────────────────────────────────
const Block = React.memo(function Block({ block, rbRefs, thawDelay }) {
  const rbRef   = useRef(null);
  const meshRef = useRef(null);

  // Register in shared maps
  useEffect(() => {
    if (rbRef.current)  rbRefs.current.set(block.id, rbRef.current);
    return () => rbRefs.current.delete(block.id);
  }, []); // eslint-disable-line

  // Tag mesh for raycaster lookup
  useEffect(() => {
    if (meshRef.current) meshRef.current.userData.blockId = block.id;
  }, []); // eslint-disable-line

  // Staggered thaw — just a plain setTimeout delay
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
 * FREE DRAG — no axis lock.
 *
 * When you mousedown/touchstart on a block:
 *   1. Ray → scene traverse → find tagged mesh → get blockId
 *   2. Build a drag plane: horizontal (Y=blockY), normal facing camera
 *   3. Every frame: project mouse onto plane → compute dx,dz (BOTH axes free)
 *   4. Apply spring force in X and Z simultaneously
 *   5. Friction from neighbours resists; you can wiggle, angle, push sideways
 *
 * On release: measure total 2D distance from origin. If > 62% of block length
 * → counts as pulled out.
 */
function DragController({ rbRefs, blocks, settled, myTurn, onPulled, setOrbitEnabled }) {
  const { camera, gl, scene } = useThree();

  const drag    = useRef(null);
  const ptr     = useRef(new THREE.Vector2());
  const ray     = useRef(new THREE.Raycaster());
  const hitPt   = useRef(new THREE.Vector3());
  const blockMap = useRef({});

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

    // Collect all tagged block meshes
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

    rb.wakeUp();
    rb.setBodyType(0); // go dynamic

    // Horizontal drag plane at block's Y, facing camera
    const pos  = rb.translation();
    const norm = new THREE.Vector3(
      camera.position.x - pos.x, 0, camera.position.z - pos.z
    ).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      norm, new THREE.Vector3(pos.x, pos.y, pos.z),
    );

    drag.current = { blockId, rb, ox: block.ox, oz: block.oz, plane };
    setOrbitEnabled(false);
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
    // FREE 2D distance check — counts whether you pulled along any direction
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

  // Spring impulse every frame — FREE X+Z movement
  useFrame(() => {
    if (!drag.current) return;
    const { rb, plane } = drag.current;

    ray.current.setFromCamera(ptr.current, camera);
    if (!ray.current.ray.intersectPlane(plane, hitPt.current)) return;

    const pos = rb.translation();
    const vel = rb.linvel();

    // ← KEY CHANGE: both dx and dz are unconstrained
    const dx = hitPt.current.x - pos.x;
    const dz = hitPt.current.z - pos.z;

    let fx = dx * SPRING_K - vel.x * DRAG_DAMP;
    let fz = dz * SPRING_K - vel.z * DRAG_DAMP;
    const fy = -vel.y * 12;

    // Cap force so you can't throw blocks across the room
    const mag = Math.sqrt(fx * fx + fz * fz);
    if (mag > MAX_FORCE) { const s = MAX_FORCE / mag; fx *= s; fz *= s; }

    rb.applyImpulse({ x: fx * 0.016, y: fy * 0.016, z: fz * 0.016 }, true);
    rb.wakeUp();
  });

  return null;
}

// ─── Table ────────────────────────────────────────────────────────────────────
function Table() {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.01, 0]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#1a0e06" roughness={0.97} />
      </mesh>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[20, 0.1, 20]} position={[0, -0.12, 0]} friction={0.98} restitution={0.0} />
      </RigidBody>
    </>
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────
function Scene({ blocks, rbRefs, thawDelays, settled, myTurn, onPulled, orbitEnabled, setOrbitEnabled }) {
  const ctrlRef = useRef(null);
  useEffect(() => {
    if (ctrlRef.current) ctrlRef.current.enabled = orbitEnabled;
  }, [orbitEnabled]);

  const topY = BH / 2 + LEVELS * (BH + STACK_GAP) + 0.6;

  return (
    <>
      <color attach="background" args={["#0d0b08"]} />
      <fog attach="fog" args={["#0d0b08", 14, 40]} />
      <ambientLight intensity={0.65} />
      <directionalLight
        position={[9, 16, 7]} intensity={2.7} castShadow
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-near={0.5} shadow-camera-far={50}
        shadow-camera-left={-8} shadow-camera-right={8}
        shadow-camera-top={12} shadow-camera-bottom={-3}
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
          <Block key={b.id} block={b} rbRefs={rbRefs} thawDelay={thawDelays[b.level]} />
        ))}
        <DragController
          rbRefs={rbRefs} blocks={blocks} settled={settled}
          myTurn={myTurn} onPulled={onPulled} setOrbitEnabled={setOrbitEnabled}
        />
      </Physics>

      <Text position={[0, topY, 0]} fontSize={0.25} color="#f0d090" anchorX="center">
        JENGA
      </Text>

      <OrbitControls
        ref={ctrlRef}
        enablePan={false} minDistance={5} maxDistance={22}
        maxPolarAngle={Math.PI / 2.05} makeDefault
      />
    </>
  );
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function HUD({ stab, needsBtn, requestGyro, myTurn, player, timeLeft, settled }) {
  const pct   = Math.round(stab);
  const color = pct > 66 ? "#4ade80" : pct > 33 ? "#fbbf24" : "#f87171";
  return (
    <div style={hud}>
      <div style={hr}><span style={hl}>Turn</span>
        <span style={{ ...hv, color: myTurn ? "#4ade80" : "#aaa" }}>
          {myTurn ? "Your turn" : `Player ${player?.slice?.(0,6) ?? player}`}
        </span>
      </div>
      <div style={hr}><span style={hl}>Timer</span>
        <span style={{ ...hv, color: timeLeft < 8 ? "#f87171" : "#fff" }}>{timeLeft}s</span>
      </div>
      <div style={hr}><span style={hl}>Stability</span>
        <span style={{ ...hv, color }}>{pct}%</span>
      </div>
      <div style={bar}><div style={{ ...barF, width: `${pct}%`, background: color }} /></div>
      {needsBtn && (
        <button style={gyroBtn} onClick={requestGyro}>📱 Enable gyro (iOS)</button>
      )}
      <div style={hint}>
        {!settled ? "Tower settling…"
          : myTurn ? "Drag any block in any direction to pull it out."
          : "Waiting for other player…"}
      </div>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function Panel({ roomCode, onCreate, onJoin, status, myId, players, onDisconnect }) {
  const [j, setJ] = useState("");
  const online = status === "online";
  return (
    <div style={panel}>
      <div style={ptitle}>Jenga</div>
      <div style={psub}>Worldwide · Physics · Room Codes</div>
      <div style={sec}>
        <button style={btn} onClick={onCreate}>Create Room</button>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={j}
            onChange={e => setJ(e.target.value.toUpperCase().slice(0, ROOM_LEN))}
            placeholder="ABCD" maxLength={ROOM_LEN} style={inp}
          />
          <button style={btn} onClick={() => onJoin(j)}>Join</button>
        </div>
      </div>
      <div style={sec}>
        {[
          ["Room",    roomCode || "——"],
          ["Server",  status],
          ["Players", String(players)],
          ["You",     myId ? myId.slice(0, 6) : "local"],
        ].map(([l, v]) => (
          <div key={l} style={sr}><span style={{ opacity: 0.5 }}>{l}</span><b>{v}</b></div>
        ))}
      </div>
      {online && (
        <button style={{ ...btn, background: "#3f1f08", marginBottom: 8 }} onClick={onDisconnect}>
          Leave room
        </button>
      )}
      <div style={hlp}>
        Share the room code with anyone worldwide.<br />
        Drag blocks in any direction to pull them out!
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [blocks, setBlocks]             = useState(buildBlocks);
  const [settled, setSettled]           = useState(false);
  const [orbitEnabled, setOrbitEnabled] = useState(true);

  const thawDelays = useMemo(() => {
    const d = {};
    for (let lvl = 0; lvl < LEVELS; lvl++) d[lvl] = BASE_THAW + lvl * PER_LEVEL;
    return d;
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSettled(true), TOTAL_SETTLE);
    return () => clearTimeout(t);
  }, []);

  const [roomCode, setRoomCode] = useState("");
  const [player, setPlayer]     = useState(1);   // current turn player ID
  const [myId, setMyId]         = useState(null);
  const [timeLeft, setTimeLeft] = useState(TURN_SEC);
  const [players, setPlayers]   = useState(1);

  const rbRefs = useRef(new Map());
  const { stab, needsBtn, requestGyro } = useGyro();
  const myTurn = myId === null || myId === player;

  // ── Remote message handler ──
  const handleMsg = useCallback((type, data) => {
    if (type === "room-state") {
      setMyId(data.yourId ?? null);
      setPlayers(data.players ?? 1);
      setPlayer(data.currentPlayer ?? 1);
      setTimeLeft(data.timeLeft ?? TURN_SEC);
      if (data.removedBlocks?.length)
        setBlocks(p => p.map(b => data.removedBlocks.includes(b.id) ? { ...b, removed: true } : b));
    }
    if (type === "block-removed")
      setBlocks(p => p.map(b => b.id === data.blockId ? { ...b, removed: true } : b));
    if (type === "turn-change") {
      setPlayer(data.player);
      setTimeLeft(TURN_SEC);
    }
    if (type === "timer-tick") setTimeLeft(data.timeLeft);
  }, []);

  const { emit, status, connect, disconnect } = useWS(handleMsg);

  // Local turn timer (used when server is not connected)
  useEffect(() => {
    if (status !== "local") return;
    const t = setInterval(() => setTimeLeft(p => {
      if (p <= 1) { setPlayer(c => c === 1 ? 2 : 1); return TURN_SEC; }
      return p - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [status]);

  // ── Block pulled ──
  const onPulled = useCallback((blockId) => {
    setBlocks(p => p.map(b => b.id === blockId ? { ...b, removed: true } : b));
    emit("block-removed", { blockId });
    // Local turn advance (server will also broadcast turn-change)
    if (status === "local") {
      const next = player === 1 ? 2 : 1;
      setPlayer(next);
      setTimeLeft(TURN_SEC);
    }
  }, [player, status, emit]);

  const resetGame = useCallback(() => {
    setBlocks(buildBlocks());
    setSettled(false);
    setPlayer(1);
    setTimeLeft(TURN_SEC);
    setTimeout(() => setSettled(true), TOTAL_SETTLE);
  }, []);

  const onCreate = useCallback(() => {
    const code = makeCode();
    setRoomCode(code);
    resetGame();
    connect(code);
  }, [connect, resetGame]);

  const onJoin = useCallback((code) => {
    const c = String(code || "").toUpperCase().trim();
    if (c.length !== ROOM_LEN) return;
    setRoomCode(c);
    connect(c);
  }, [connect]);

  const onDisconnect = useCallback(() => {
    disconnect();
    setRoomCode("");
    setMyId(null);
    setPlayers(1);
  }, [disconnect]);

  return (
    <div style={root}>
      <Panel
        roomCode={roomCode} onCreate={onCreate} onJoin={onJoin}
        status={status} myId={myId} players={players} onDisconnect={onDisconnect}
      />

      <Canvas shadows camera={{ position: [7, 9.5, 9], fov: 44 }}
              style={{ position: "absolute", inset: 0 }} gl={{ antialias: true }}>
        <Scene
          blocks={blocks} rbRefs={rbRefs} thawDelays={thawDelays}
          settled={settled} myTurn={myTurn} onPulled={onPulled}
          orbitEnabled={orbitEnabled} setOrbitEnabled={setOrbitEnabled}
        />
      </Canvas>

      <HUD stab={stab} needsBtn={needsBtn} requestGyro={requestGyro}
           myTurn={myTurn} player={player} timeLeft={timeLeft} settled={settled} />

      {!settled && (
        <div style={ovl}>
          <div style={ovlBox}>
            <div style={ovlTitle}>Stacking blocks…</div>
            <div style={ovlTrack}>
              <div style={{ ...ovlFill, animationDuration: `${TOTAL_SETTLE / 1000}s` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const root  = { width:"100vw", height:"100vh", overflow:"hidden", background:"#0d0b08", fontFamily:"'Inter',system-ui,sans-serif" };
const glass = { background:"rgba(10,8,5,0.82)", backdropFilter:"blur(18px)", WebkitBackdropFilter:"blur(18px)", borderRadius:16, border:"1px solid rgba(255,255,255,0.08)", boxShadow:"0 10px 40px rgba(0,0,0,0.6)", color:"#fff", padding:16 };
const panel   = { ...glass, position:"absolute", top:16, left:16, zIndex:10, width:268 };
const ptitle  = { fontWeight:900, fontSize:22, letterSpacing:"0.04em", marginBottom:2, color:"#f0d090" };
const psub    = { fontSize:12, opacity:0.45, marginBottom:14, letterSpacing:"0.07em" };
const sec     = { display:"grid", gap:8, marginBottom:12, padding:10, borderRadius:12, background:"rgba(255,255,255,0.04)" };
const btn     = { border:0, borderRadius:10, padding:"10px 14px", background:"#7a4010", color:"#fff", fontWeight:800, fontSize:13, cursor:"pointer" };
const inp     = { flex:1, minWidth:0, border:"1px solid rgba(255,255,255,0.1)", outline:"none", borderRadius:10, padding:"10px 12px", fontWeight:800, letterSpacing:"0.18em", background:"rgba(255,255,255,0.07)", color:"#fff", fontSize:15 };
const sr      = { display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:13 };
const hlp     = { fontSize:12, opacity:0.4, lineHeight:1.55, marginTop:4 };
const hud     = { ...glass, position:"absolute", bottom:16, right:16, zIndex:10, width:228 };
const hr      = { display:"flex", justifyContent:"space-between", marginBottom:8 };
const hl      = { fontSize:12, opacity:0.5 };
const hv      = { fontWeight:900, fontSize:15 };
const bar     = { height:6, borderRadius:4, background:"rgba(255,255,255,0.08)", overflow:"hidden", marginBottom:10 };
const barF    = { height:"100%", borderRadius:4, transition:"width 0.22s ease, background 0.4s ease" };
const hint    = { fontSize:11, opacity:0.42, lineHeight:1.5 };
const gyroBtn = { width:"100%", border:0, borderRadius:10, padding:"9px 0", background:"#1d4ed8", color:"#fff", fontWeight:800, fontSize:13, cursor:"pointer", marginBottom:10 };
const ovl     = { position:"absolute", inset:0, zIndex:20, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(0,0,0,0.65)", backdropFilter:"blur(5px)" };
const ovlBox  = { ...glass, textAlign:"center", width:220 };
const ovlTitle = { fontWeight:800, fontSize:17, color:"#f0d090", marginBottom:14 };
const ovlTrack = { height:5, borderRadius:4, background:"rgba(255,255,255,0.1)", overflow:"hidden" };
const ovlFill  = { height:"100%", borderRadius:4, background:"#7a4010", animation:"grow linear forwards" };