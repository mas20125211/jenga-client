/**
 * Jenga — App.jsx (Upgraded Client)
 * Includes: Lean Meter, Chat, Rebuild, Visual Upgrades, and Room Environments.
 * Note: Physics remains client-side. Server-authoritative physics requires a separate Node.js backend.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text, Environment, Outlines } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider } from "@react-three/rapier";
import { ref, set, onValue, update, push } from "firebase/database";
import { db } from "./firebase"; //
import * as THREE from "three";

// ─── Constants ────────────────────────────────────────────────────────────────
const BW = 1.05;
const BH = 0.30;
const BD = 0.34;
const STACK_GAP = 0.001;
const ROW_GAP   = 0.003;
const LEVELS    = 18;
const ROOM_LEN  = 10;
const TURN_SEC  = 60;

const GRAVITY     = -11;
const FRICTION    = 0.90;
const RESTITUTION = 0.0;
const LIN_DAMP    = 5.5;
const ANG_DAMP    = 6.0;
const MASS        = 1.8;

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
        px: alongX ? 0 : off,  py: y,  pz: alongX ? off : 0,
        ry: alongX ? 0 : Math.PI / 2,
        ox: alongX ? 0 : off,  oz: alongX ? off : 0,
      });
    }
  }
  return out;
}

const makeCode = () => {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: ROOM_LEN }, () => c[~~(Math.random() * c.length)]).join("");
};

// ─── Firebase hook (Upgraded for Chat & Rebuild) ──────────────────────────────
function useFirebaseRoom(myId) {
  const unsubRef = useRef(null);
  const roomDataRef = useRef(null);

  const [roomCode, setRoomCode] = useState("");
  const [status, setStatus] = useState("local");
  const [currentTurn, setCurrentTurn] = useState(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [removedIds, setRemovedIds] = useState([]);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [gameIteration, setGameIteration] = useState(0); // For rebuilding
  const [envType, setEnvType] = useState("apartment"); // Environments

  const applySnapshot = useCallback((data) => {
    roomDataRef.current = data;
    if (data.current) setCurrentTurn(data.current);
    const count = data.players ? Object.values(data.players).filter(Boolean).length : 0;
    setPlayerCount(count);
    setRemovedIds(data.removed ? Object.keys(data.removed) : []);
    setChatMsgs(data.chat ? Object.values(data.chat) : []);
    setGameIteration(data.iteration || 0);
    setEnvType(data.envType || "apartment");
  }, []);

  const subscribe = useCallback((code) => {
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

  const createRoom = useCallback((code) => {
    set(ref(db, `rooms/${code}`), {
      current: myId,
      players: { [myId]: Date.now() },
      removed: {},
      chat: {},
      iteration: 0,
      envType: "apartment",
      createdAt: Date.now(),
    });
    setRoomCode(code);
    subscribe(code);
  }, [myId, subscribe]);

  const joinRoom = useCallback((code) => {
    update(ref(db, `rooms/${code}`), { [`players/${myId}`]: Date.now() });
    setRoomCode(code);
    subscribe(code);
  }, [myId, subscribe]);

  const sendChat = useCallback((msg, author) => {
    if (!roomCode) return;
    push(ref(db, `rooms/${roomCode}/chat`), { text: msg, author, time: Date.now() });
  }, [roomCode]);

  const triggerRebuild = useCallback(() => {
    if (!roomCode) return;
    update(ref(db, `rooms/${roomCode}`), {
      removed: {},
      iteration: (roomDataRef.current?.iteration || 0) + 1,
      current: myId // Resetter goes first
    });
  }, [roomCode, myId]);

  const changeEnv = useCallback((type) => {
    if (!roomCode) return;
    update(ref(db, `rooms/${roomCode}`), { envType: type });
  }, [roomCode]);

  return {
    roomCode, status, currentTurn, playerCount, removedIds, chatMsgs, gameIteration, envType,
    createRoom, joinRoom, sendChat, triggerRebuild, changeEnv
  };
}

// ─── Block component (Upgraded visuals + hover) ───────────────────────────────
const Block = React.memo(function Block({ block, rbRefs, thawDelay }) {
  const rbRef = useRef(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (rbRef.current) rbRefs.current.set(block.id, rbRef.current);
    return () => rbRefs.current.delete(block.id);
  }, [block.id, rbRefs]);

  useEffect(() => {
    const t = setTimeout(() => rbRef.current?.setBodyType(0), thawDelay);
    return () => clearTimeout(t);
  }, [thawDelay]);

  if (block.removed) return null;

  return (
    <RigidBody
      ref={rbRef}
      position={[block.px, block.py, block.pz]}
      rotation={[0, block.ry, 0]}
      type="kinematicPosition"
      colliders={false}
      mass={MASS} friction={FRICTION} restitution={RESTITUTION}
      linearDamping={LIN_DAMP} angularDamping={ANG_DAMP}
      canSleep
    >
      <CuboidCollider args={[BW/2 - 0.002, BH/2 - 0.002, BD/2 - 0.002]} />
      <mesh 
        userData={{ blockId: block.id }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={(e) => { e.stopPropagation(); setHovered(false); }}
        castShadow receiveShadow
      >
        <boxGeometry args={[BW, BH, BD]} />
        {/* Upgraded visual realism */}
        <meshStandardMaterial 
          color={hovered ? "#e8a05f" : "#c47a3a"} 
          roughness={0.7} 
          metalness={0.05} 
        />
        {hovered && <Outlines thickness={0.015} color="#ffffff" />}
      </mesh>
    </RigidBody>
  );
});

// ─── Tower Analytics (Lean Meter) ─────────────────────────────────────────────
function LeanMeter({ rbRefs, blocks, onUpdateRisk }) {
  useFrame(() => {
    let sumX = 0, sumZ = 0, count = 0;
    blocks.forEach(b => {
      if (!b.removed) {
        const rb = rbRefs.current.get(b.id);
        if (rb && rb.bodyType() === 0) { // Only dynamic blocks
          const pos = rb.translation();
          sumX += pos.x; sumZ += pos.z; count++;
        }
      }
    });
    if (count === 0) return;
    
    const avgX = sumX / count;
    const avgZ = sumZ / count;
    const drift = Math.sqrt(avgX * avgX + avgZ * avgZ);
    
    // Drift > 0.35 is highly unstable.
    const riskPct = Math.min(Math.round((drift / 0.35) * 100), 100);
    onUpdateRisk(riskPct);
  });
  return null;
}

// ─── 3-D scene (Upgraded Environment) ─────────────────────────────────────────
function Scene({ blocks, rbRefs, thawDelays, envType, setRisk }) {
  return (
    <>
      <color attach="background" args={envType === "night" ? ["#050508"] : ["#0d0b08"]} />
      <Environment preset={envType === "night" ? "city" : envType} background blur={0.5} />
      
      <ambientLight intensity={0.5} />
      <directionalLight position={[9, 16, 7]} intensity={1.5} castShadow />

      <Physics gravity={[0, GRAVITY, 0]} timeStep={1/60}>
        {/* Table/Floor */}
        <RigidBody type="fixed" colliders="cuboid">
           <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.01, 0]}>
             <planeGeometry args={[40, 40]} />
             <meshStandardMaterial color="#1a0e06" roughness={0.9} />
           </mesh>
        </RigidBody>

        {blocks.map(b => (
          <Block key={b.id} block={b} rbRefs={rbRefs} thawDelay={thawDelays[b.level]} />
        ))}
        
        <LeanMeter rbRefs={rbRefs} blocks={blocks} onUpdateRisk={setRisk} />
      </Physics>
      <OrbitControls makeDefault minDistance={5} maxDistance={22} maxPolarAngle={Math.PI / 2} />
    </>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [myId] = useState(() => Math.random().toString(36).slice(2, 10));
  const [blocks, setBlocks] = useState(buildBlocks);
  const [settled, setSettled] = useState(false);
  const [risk, setRisk] = useState(0); // Lean Meter
  
  const rbRefs = useRef(new Map());

  const thawDelays = useMemo(() => {
    const d = {};
    for (let lvl = 0; lvl < LEVELS; lvl++) d[lvl] = BASE_THAW + lvl * PER_LEVEL;
    return d;
  }, []);

  const {
    roomCode, status, playerCount, removedIds, chatMsgs, gameIteration, envType,
    createRoom, joinRoom, sendChat, triggerRebuild, changeEnv
  } = useFirebaseRoom(myId);

  // Rebuild Tower Trigger
  useEffect(() => {
    if (gameIteration > 0) {
      setBlocks(buildBlocks());
      setSettled(false);
      setTimeout(() => setSettled(true), TOTAL_SETTLE);
    }
  }, [gameIteration]);

  // Sync removed blocks
  useEffect(() => {
    if (!removedIds.length && gameIteration > 0) return; // Prevent clearing during rebuild
    setBlocks(prev => prev.map(b => removedIds.includes(b.id) ? { ...b, removed: true } : b));
  }, [removedIds, gameIteration]);

  return (
    <div style={root}>
      {/* Settings / Info Panel */}
      <div style={panel}>
        <div style={{ color: "#f0d090", fontSize: 20, fontWeight: "bold" }}>JENGA</div>
        {!roomCode ? (
          <button onClick={() => createRoom(makeCode())} style={btn}>Create Room</button>
        ) : (
          <>
            <div style={{ fontSize: 14 }}>Room: <b>{roomCode}</b> ({playerCount} players)</div>
            <button onClick={triggerRebuild} style={{...btn, background:"#b91c1c", marginTop: 8}}>
              Rebuild Tower
            </button>
            <div style={{ marginTop: 8 }}>
              <label>Environment: </label>
              <select value={envType} onChange={e => changeEnv(e.target.value)} style={{ background: "#333", color:"#fff" }}>
                <option value="apartment">Living Room</option>
                <option value="studio">Minimal Studio</option>
                <option value="night">Dark Mode</option>
              </select>
            </div>
          </>
        )}
      </div>

      {/* Lean Meter HUD */}
      <div style={hud}>
        <div style={{ fontSize: 14, marginBottom: 4 }}>Fall Risk: {risk}%</div>
        <div style={{ width: "100%", height: 8, background: "#333", borderRadius: 4 }}>
          <div style={{ height: "100%", width: `${risk}%`, background: risk > 50 ? "red" : risk > 20 ? "orange" : "green", borderRadius: 4, transition: "width 0.2s" }} />
        </div>
      </div>

      {/* Chat UI */}
      {roomCode && (
        <div style={chatBox}>
          <div style={{ flex: 1, overflowY: "auto", marginBottom: 8 }}>
            {chatMsgs.map((m, i) => (
              <div key={i} style={{ fontSize: 12, margin: "4px 0" }}>
                <b style={{ color: m.author === myId ? "#4ade80" : "#aaa" }}>{m.author.slice(0,4)}: </b> {m.text}
              </div>
            ))}
          </div>
          <input 
            placeholder="Type message..." 
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.target.value) {
                sendChat(e.target.value, myId);
                e.target.value = "";
              }
            }}
            style={inp} 
          />
        </div>
      )}

      <Canvas shadows camera={{ position: [7, 9.5, 9], fov: 44 }} style={{ position: "absolute", inset: 0 }}>
        <Scene blocks={blocks} rbRefs={rbRefs} thawDelays={thawDelays} envType={envType} setRisk={setRisk} />
      </Canvas>
    </div>
  );
}

// ─── Styles (Abbreviated) ─────────────────────────────────────────────────────
const root = { width:"100vw", height:"100vh", overflow:"hidden", background:"#0d0b08", color: "#fff", fontFamily:"sans-serif" };
const glass = { background:"rgba(10,8,5,0.84)", backdropFilter:"blur(10px)", borderRadius:8, padding:16, border:"1px solid rgba(255,255,255,0.1)", zIndex: 10 };
const panel = { ...glass, position:"absolute", top:16, left:16, width: 250 };
const hud = { ...glass, position:"absolute", top:16, right:16, width: 200, textAlign: "center" };
const chatBox = { ...glass, position:"absolute", bottom:16, left:16, width: 250, height: 200, display:"flex", flexDirection:"column" };
const btn = { width: "100%", padding: "8px", borderRadius: "6px", background: "#4ade80", color: "#000", border: "none", cursor: "pointer", fontWeight: "bold" };
const inp = { width: "100%", padding: "8px", borderRadius: "6px", border: "none", background: "#222", color: "#fff" };