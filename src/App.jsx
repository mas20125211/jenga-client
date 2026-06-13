/**
 * Jenga — App.jsx  (Full Multiplayer Upgrade)
 *
 * ✓ Host-authoritative physics sync  — host runs Rapier, broadcasts block
 *   transforms at ~10 fps via Firebase; clients apply kinematically
 * ✓ Block ownership + locking        — outlines show who is interacting
 * ✓ Procedural wood textures         — canvas-based grain, knots, highlights
 * ✓ 4-point studio lighting          — no dark angles; contact shadows
 * ✓ Lean Meter + Fall Risk           — weighted: lean 40 % / velocity 40 % / removed 20 %
 * ✓ 6 selectable environments
 * ✓ Room settings modal              — password, gravity, tower height
 * ✓ Camera shake on collapse
 * ✓ Web Audio sound FX               — tap / pull / crash (no files needed)
 * ✓ Match statistics
 * ✓ Spectator mode
 * ✓ Enhanced chat with player colours
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Environment, Outlines, ContactShadows } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider } from "@react-three/rapier";
import { ref, set, onValue, update, push, get } from "firebase/database";
import { db } from "./firebase";
import * as THREE from "three";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const BW = 1.05, BH = 0.30, BD = 0.34;
const STACK_GAP = 0.001, ROW_GAP = 0.003;
const DEFAULT_LEVELS = 18;
const CODE_LEN = 10;

const PHYS = { friction: 0.90, restitution: 0.0, linDamp: 5.5, angDamp: 6.0, mass: 1.8 };
const BASE_THAW = 700, PER_LEVEL = 80;
const SETTLE_MS = BASE_THAW + DEFAULT_LEVELS * PER_LEVEL + 600;

// Player accent colours (round-robin)
const P_COLORS = [
  "#4ade80", "#f472b6", "#60a5fa", "#fb923c",
  "#a78bfa", "#facc15", "#34d399", "#e879f9",
];

// Environment configurations
const ENVS = {
  apartment: { label: "Living Room",  preset: "apartment", bg: "#1a1008", floor: "#1a0e06", amb: 0.60 },
  studio:    { label: "Studio",       preset: "studio",    bg: "#0c0c0c", floor: "#111111", amb: 0.90 },
  night:     { label: "Night City",   preset: "night",     bg: "#05050a", floor: "#0a0a14", amb: 0.30 },
  warehouse: { label: "Garage",       preset: "warehouse", bg: "#0d0c0a", floor: "#1a1a18", amb: 0.50 },
  dawn:      { label: "Rooftop Dawn", preset: "dawn",      bg: "#1a0d05", floor: "#180f06", amb: 0.70 },
  forest:    { label: "Forest Cabin", preset: "forest",    bg: "#050c05", floor: "#0a120a", amb: 0.50 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const makeCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: CODE_LEN }, () => chars[~~(Math.random() * chars.length)]).join("");
};

function buildBlocks(levels = DEFAULT_LEVELS) {
  const blocks = [];
  for (let lvl = 0; lvl < levels; lvl++) {
    const alongX = lvl % 2 === 0;
    const y = BH / 2 + lvl * (BH + STACK_GAP);
    for (let col = 0; col < 3; col++) {
      const off = (col - 1) * (BD + ROW_GAP);
      blocks.push({
        id: `b${lvl}-${col}`,
        level: lvl,
        removed: false,
        px: alongX ? 0 : off,
        py: y,
        pz: alongX ? off : 0,
        ry: alongX ? 0 : Math.PI / 2,
      });
    }
  }
  return blocks;
}

// ─── Procedural wood texture ──────────────────────────────────────────────────
function makeWoodTexture() {
  const C = document.createElement("canvas");
  C.width = 256; C.height = 128;
  const ctx = C.getContext("2d");

  // Base gradient (end-grain warmth)
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0,   "#a05828");
  g.addColorStop(0.3, "#c47a3a");
  g.addColorStop(0.6, "#d48848");
  g.addColorStop(1,   "#b06030");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 128);

  // Long-grain lines
  for (let i = 0; i < 38; i++) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.14})`;
    ctx.lineWidth = 0.4 + Math.random() * 1.1;
    let y = Math.random() * 128;
    ctx.moveTo(0, y);
    for (let x = 0; x < 256; x += 6) {
      y += (Math.random() - 0.5) * 2.4;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Knots
  for (let k = 0; k < 3; k++) {
    const kx = 20 + Math.random() * 216, ky = 8 + Math.random() * 112;
    const rg = ctx.createRadialGradient(kx, ky, 0, kx, ky, 14);
    rg.addColorStop(0,   "rgba(55,25,5,0.75)");
    rg.addColorStop(0.5, "rgba(80,40,10,0.30)");
    rg.addColorStop(1,   "rgba(80,40,10,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.ellipse(kx, ky, 14, 7, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle top-light bevel
  const hl = ctx.createLinearGradient(0, 0, 0, 128);
  hl.addColorStop(0,   "rgba(255,255,255,0.07)");
  hl.addColorStop(0.45, "rgba(255,255,255,0)");
  hl.addColorStop(1,   "rgba(0,0,0,0.09)");
  ctx.fillStyle = hl;
  ctx.fillRect(0, 0, 256, 128);

  const tex = new THREE.CanvasTexture(C);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Singleton texture (created once, reused)
let _woodTex = null;
const woodTex = () => { if (!_woodTex) _woodTex = makeWoodTexture(); return _woodTex; };

// ═══════════════════════════════════════════════════════════════════════════════
// WEB AUDIO SOUND EFFECTS  (no external files)
// ═══════════════════════════════════════════════════════════════════════════════

function useAudio() {
  const ctxRef = useRef(null);
  const resume = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    return ctxRef.current;
  };

  const playTap = useCallback(() => {
    try {
      const ctx = resume();
      const buf = ctx.createBuffer(1, ~~(ctx.sampleRate * 0.11), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.013));
      const src = ctx.createBufferSource();
      const filt = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      filt.type = "bandpass"; filt.frequency.value = 950; filt.Q.value = 3.5;
      src.buffer = buf;
      src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.38, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.11);
      src.start();
    } catch (_) {}
  }, []);

  const playPull = useCallback(() => {
    try {
      const ctx = resume();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(520, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(170, ctx.currentTime + 0.28);
      gain.gain.setValueAtTime(0.13, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.28);
    } catch (_) {}
  }, []);

  const playCrash = useCallback(() => {
    try {
      const ctx = resume();
      const buf = ctx.createBuffer(1, ~~(ctx.sampleRate * 1.1), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.38));
      const src = ctx.createBufferSource();
      const filt = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      filt.type = "lowpass"; filt.frequency.value = 380;
      src.buffer = buf;
      src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.95, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.1);
      src.start();
    } catch (_) {}
  }, []);

  return { playTap, playPull, playCrash };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIREBASE ROOM HOOK
// ═══════════════════════════════════════════════════════════════════════════════

function useFirebaseRoom(myId) {
  const unsubRef  = useRef(null);
  const snapRef   = useRef(null);   // mirror of latest Firebase snapshot

  const [roomCode,          setRoomCode]          = useState("");
  const [status,            setStatus]            = useState("local");
  const [isHost,            setIsHost]            = useState(false);
  const [players,           setPlayers]           = useState({});
  const [currentTurn,       setCurrentTurn]       = useState(null);
  const [removedIds,        setRemovedIds]        = useState([]);
  const [lockedBlocks,      setLockedBlocks]      = useState({});  // { blockId: playerId }
  const [chatMsgs,          setChatMsgs]          = useState([]);
  const [gameIteration,     setGameIteration]     = useState(0);
  const [envType,           setEnvType]           = useState("apartment");
  const [remoteBlockStates, setRemoteBlockStates] = useState({});
  const [roomSettings,      setRoomSettings]      = useState({ gravity: -11, levels: 18, password: "" });
  const [matchStats,        setMatchStats]        = useState({});
  const [isSpectator,       setIsSpectator]       = useState(false);

  const applySnapshot = useCallback((data) => {
    snapRef.current = data;
    if (data.current)   setCurrentTurn(data.current);
    setPlayers(data.players || {});
    setRemovedIds(data.removed ? Object.keys(data.removed) : []);
    setLockedBlocks(data.locked || {});
    setChatMsgs(
      data.chat
        ? Object.values(data.chat).sort((a, b) => a.time - b.time)
        : [],
    );
    setGameIteration(data.iteration || 0);
    setEnvType(data.envType || "apartment");
    if (data.settings) setRoomSettings((s) => ({ ...s, ...data.settings }));
    setMatchStats(data.stats || {});
    if (data.blockStates) setRemoteBlockStates(data.blockStates);
  }, []);

  const subscribe = useCallback((code) => {
    unsubRef.current?.();
    setStatus("connecting");
    const unsub = onValue(ref(db, `rooms/${code}`), (snap) => {
      const data = snap.val();
      if (!data) { setStatus("not found"); return; }
      setStatus("online");
      applySnapshot(data);
    });
    unsubRef.current = unsub;
  }, [applySnapshot]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const createRoom = useCallback(async (code, extraSettings = {}) => {
    const settings = { gravity: -11, levels: 18, password: "", ...extraSettings };
    await set(ref(db, `rooms/${code}`), {
      hostId: myId,
      current: myId,
      players: { [myId]: { name: `P-${myId.slice(0, 4)}`, joinedAt: Date.now(), isSpectator: false } },
      removed: {}, locked: {}, chat: {},
      iteration: 0, envType: "apartment",
      settings, stats: {}, createdAt: Date.now(),
    });
    setRoomCode(code);
    setIsHost(true);
    subscribe(code);
  }, [myId, subscribe]);

  const joinRoom = useCallback(async (code, password = "", spectator = false) => {
    const snap = await get(ref(db, `rooms/${code}`));
    const data = snap.val();
    if (!data) return { error: "Room not found" };
    if (data.settings?.password && data.settings.password !== password)
      return { error: "Incorrect password" };
    await update(ref(db, `rooms/${code}`), {
      [`players/${myId}`]: { name: `P-${myId.slice(0, 4)}`, joinedAt: Date.now(), isSpectator: spectator },
    });
    setRoomCode(code);
    setIsHost(data.hostId === myId);
    setIsSpectator(spectator);
    subscribe(code);
    return { success: true };
  }, [myId, subscribe]);

  const sendChat = useCallback((text) => {
    if (!roomCode) return;
    push(ref(db, `rooms/${roomCode}/chat`), {
      text,
      authorId: myId,
      name: `P-${myId.slice(0, 4)}`,
      time: Date.now(),
    });
  }, [roomCode, myId]);

  const triggerRebuild = useCallback(() => {
    if (!roomCode) return;
    update(ref(db, `rooms/${roomCode}`), {
      removed: {}, locked: {}, blockStates: null,
      iteration: (snapRef.current?.iteration || 0) + 1,
      current: myId,
    });
  }, [roomCode, myId]);

  const changeEnv = useCallback((type) => {
    if (roomCode) update(ref(db, `rooms/${roomCode}`), { envType: type });
  }, [roomCode]);

  const updateSettings = useCallback((settings) => {
    if (roomCode) update(ref(db, `rooms/${roomCode}`), { settings });
  }, [roomCode]);

  const lockBlock = useCallback((blockId) => {
    if (roomCode) update(ref(db, `rooms/${roomCode}/locked`), { [blockId]: myId });
  }, [roomCode, myId]);

  const unlockBlock = useCallback((blockId) => {
    if (roomCode) update(ref(db, `rooms/${roomCode}/locked`), { [blockId]: null });
  }, [roomCode]);

  const removeBlock = useCallback((blockId) => {
    if (!roomCode) return;
    const allIds = Object.keys(snapRef.current?.players || {});
    const myIdx  = allIds.indexOf(myId);
    const nextId = allIds[(myIdx + 1) % allIds.length] || myId;
    const prevRemovals = snapRef.current?.stats?.[myId]?.removals || 0;
    update(ref(db, `rooms/${roomCode}`), {
      [`removed/${blockId}`]: true,
      [`locked/${blockId}`]:  null,
      current: nextId,
      [`stats/${myId}/removals`]: prevRemovals + 1,
      [`stats/${myId}/name`]:     `P-${myId.slice(0, 4)}`,
    });
  }, [roomCode, myId]);

  // Host only — push block positions at ~10 fps
  const pushBlockStates = useCallback((states) => {
    if (roomCode && isHost)
      update(ref(db, `rooms/${roomCode}/blockStates`), states);
  }, [roomCode, isHost]);

  const recordCollapse = useCallback((blockCount) => {
    if (roomCode)
      update(ref(db, `rooms/${roomCode}/stats`), {
        lastCollapse: { blocks: blockCount, at: Date.now(), causedBy: currentTurn },
      });
  }, [roomCode, currentTurn]);

  return {
    roomCode, status, isHost, players, currentTurn, removedIds, lockedBlocks,
    chatMsgs, gameIteration, envType, remoteBlockStates, roomSettings, matchStats, isSpectator,
    createRoom, joinRoom, sendChat, triggerRebuild, changeEnv, updateSettings,
    lockBlock, unlockBlock, removeBlock, pushBlockStates, recordCollapse,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCK COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

const Block = React.memo(function Block({
  block, rbRefs, thawDelay,
  isHost, remoteState,
  isInteractable, isSelected, lockedByColor,
  onSelect, controlsRef,
}) {
  const rbRef  = useRef(null);
  const [hov, setHov] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({
    offset: new THREE.Vector3(),
    y: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const tex = woodTex();
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const canAct = isInteractable && !lockedByColor;

  // Register ref
  useEffect(() => {
    if (rbRef.current) rbRefs.current.set(block.id, rbRef.current);
    return () => rbRefs.current.delete(block.id);
  }, [block.id, rbRefs]);

  // Host: thaw to dynamic after settle
  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => rbRef.current?.setBodyType(0), thawDelay);
    return () => clearTimeout(t);
  }, [thawDelay, isHost]);

  const moveToPointer = useCallback((clientX, clientY) => {
    const rb = rbRef.current;
    if (!rb) return;

    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );

    raycaster.setFromCamera(ndc, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dragRef.current.y);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return;

    const next = {
      x: hit.x - dragRef.current.offset.x,
      y: dragRef.current.y,
      z: hit.z - dragRef.current.offset.z,
    };

    // Kinematic bodies respond more reliably to next-translation updates.
    rb.setNextKinematicTranslation(next);
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }, [camera, gl, raycaster]);

  // Clients: apply kinematic transform from Firebase
  useFrame(() => {
    if (isHost || !remoteState || !rbRef.current) return;
    rbRef.current.setNextKinematicTranslation({
      x: remoteState.px, y: remoteState.py, z: remoteState.pz,
    });
    rbRef.current.setNextKinematicRotation({
      x: remoteState.rx, y: remoteState.ry, z: remoteState.rz, w: remoteState.rw ?? 1,
    });
  });

  useEffect(() => {
    if (!isDragging) return;

    if (controlsRef?.current) controlsRef.current.enabled = false;

    const onMove = (ev) => {
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      if (Math.hypot(dx, dy) > 4) dragRef.current.moved = true;
      moveToPointer(ev.clientX, ev.clientY);
    };

    const stopDrag = () => {
      setIsDragging(false);
      if (controlsRef?.current) controlsRef.current.enabled = true;
      document.body.style.cursor = "default";
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      if (controlsRef?.current) controlsRef.current.enabled = true;
    };
  }, [isDragging, moveToPointer, controlsRef]);

  useEffect(() => () => {
    if (document.body.style.cursor === "grabbing") document.body.style.cursor = "default";
  }, []);

  if (block.removed) return null;

  const emissive  = isSelected ? "#704810" : hov && canAct ? "#2a1005" : "#000000";
  const emissiveI = isSelected ? 0.5 : hov && canAct ? 0.25 : 0;
  const tintColor = lockedByColor ?? "#c47a3a";
  const showOutline = isSelected || !!lockedByColor || (hov && canAct);
  const outlineClr  = isSelected ? "#ffee44" : lockedByColor ?? "#ffffff";
  const outlineW    = isSelected ? 0.03 : lockedByColor ? 0.02 : 0.015;

  return (
    <RigidBody
      ref={rbRef}
      position={[block.px, block.py, block.pz]}
      rotation={[0, block.ry, 0]}
      type="kinematicPosition"
      colliders={false}
      mass={PHYS.mass}
      friction={PHYS.friction}
      restitution={PHYS.restitution}
      linearDamping={PHYS.linDamp}
      angularDamping={PHYS.angDamp}
      canSleep
    >
      <CuboidCollider args={[BW / 2 - 0.002, BH / 2 - 0.002, BD / 2 - 0.002]} />
      <mesh
        castShadow receiveShadow
        onPointerOver={(e) => {
          e.stopPropagation();
          setHov(true);
          document.body.style.cursor = isDragging ? "grabbing" : canAct ? "pointer" : "not-allowed";
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          setHov(false);
          if (!isDragging) document.body.style.cursor = "default";
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (!canAct || !isSelected || !rbRef.current) return;

          e.target.setPointerCapture?.(e.pointerId);
          const pos = rbRef.current.translation();
          dragRef.current.offset.set(e.point.x - pos.x, 0, e.point.z - pos.z);
          dragRef.current.y = pos.y;
          dragRef.current.startX = e.clientX;
          dragRef.current.startY = e.clientY;
          dragRef.current.moved = false;
          setIsDragging(true);
          document.body.style.cursor = "grabbing";
        }}
        onPointerMove={(e) => {
          if (!isDragging) return;
          e.stopPropagation();
        }}
        onPointerUp={(e) => {
          if (!isDragging) return;
          e.stopPropagation();
          e.target.releasePointerCapture?.(e.pointerId);
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (dragRef.current.moved) {
            dragRef.current.moved = false;
            return;
          }
          if (canAct) onSelect(block.id);
        }}
      >
        <boxGeometry args={[BW, BH, BD]} />
        <meshStandardMaterial
          map={tex}
          color={tintColor}
          emissive={emissive}
          emissiveIntensity={emissiveI}
          roughness={0.73}
          metalness={0.04}
        />
        {showOutline && <Outlines thickness={outlineW} color={outlineClr} />}
      </mesh>
    </RigidBody>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// HOST PHYSICS SYNC  (~10 fps, change-gated)
// ═══════════════════════════════════════════════════════════════════════════════

function HostSync({ rbRefs, blocks, pushBlockStates }) {
  const frame     = useRef(0);
  const lastState = useRef({});

  useFrame(() => {
    if (++frame.current < 6) return;
    frame.current = 0;

    const states = {};
    let changed = false;

    blocks.forEach((b) => {
      if (b.removed) return;
      const rb = rbRefs.current.get(b.id);
      if (!rb || rb.bodyType() !== 0) return; // only dynamic blocks

      const p = rb.translation(), r = rb.rotation();
      const ns = {
        px: +p.x.toFixed(3), py: +p.y.toFixed(3), pz: +p.z.toFixed(3),
        rx: +r.x.toFixed(4), ry: +r.y.toFixed(4), rz: +r.z.toFixed(4), rw: +r.w.toFixed(4),
      };
      const ls = lastState.current[b.id];
      if (!ls ||
          Math.abs(ns.px - ls.px) > 0.001 ||
          Math.abs(ns.py - ls.py) > 0.001 ||
          Math.abs(ns.pz - ls.pz) > 0.001) {
        states[b.id] = ns;
        lastState.current[b.id] = ns;
        changed = true;
      }
    });

    if (changed) pushBlockStates(states);
  });

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOWER ANALYTICS  (Lean Meter + Fall Risk)
// ═══════════════════════════════════════════════════════════════════════════════

function TowerAnalytics({ rbRefs, blocks, totalBlocks, onUpdate }) {
  const velHistory = useRef([]);

  useFrame(() => {
    let sumX = 0, sumZ = 0, sumVel = 0, living = 0, dynCount = 0;

    blocks.forEach((b) => {
      if (b.removed) return;
      const rb = rbRefs.current.get(b.id);
      if (!rb) return;
      const pos = rb.translation();
      sumX += pos.x; sumZ += pos.z; living++;
      if (rb.bodyType() === 0) {
        const v = rb.linvel();
        sumVel += Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
        dynCount++;
      }
    });

    if (living === 0) return;

    const drift  = Math.sqrt((sumX / living) ** 2 + (sumZ / living) ** 2);
    const avgVel = dynCount > 0 ? sumVel / dynCount : 0;

    const leanF    = Math.min(drift / 0.35, 1);
    const velF     = Math.min(avgVel / 2.5, 1);
    const removeF  = Math.min((1 - living / totalBlocks) / 0.6, 1);

    const risk = Math.round((leanF * 0.40 + velF * 0.40 + removeF * 0.20) * 100);
    const lean = Math.round(leanF * 100);

    velHistory.current.push(avgVel);
    if (velHistory.current.length > 30) velHistory.current.shift();
    const instability = velHistory.current.slice(-10).reduce((a, b) => a + b, 0) / 10;

    onUpdate({ risk, lean, avgVel, instability });
  });

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAMERA SHAKE
// ═══════════════════════════════════════════════════════════════════════════════

function CameraShake({ triggerRef }) {
  const { camera } = useThree();
  const intensity  = useRef(0);

  useEffect(() => {
    triggerRef.current = (v) => { intensity.current = v; };
  }, [triggerRef]);

  useFrame(() => {
    if (intensity.current < 0.002) return;
    camera.position.x += (Math.random() - 0.5) * intensity.current * 0.14;
    camera.position.y += (Math.random() - 0.5) * intensity.current * 0.07;
    intensity.current *= 0.87;
  });

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENE
// ═══════════════════════════════════════════════════════════════════════════════

function Scene({
  blocks, rbRefs, thawDelays, gameIteration,
  envType, isHost, remoteBlockStates, pushBlockStates,
  isMyTurn, lockedBlocks, playerColorMap, selectedBlock, onSelectBlock,
  onAnalyticsUpdate, shakeRef, gravity, controlsRef,
}) {
  const env        = ENVS[envType] || ENVS.apartment;
  const totalBlks  = blocks.length;

  return (
    <>
      <color attach="background" args={[env.bg]} />
      <fog attach="fog" args={[env.bg, 20, 55]} />
      <Environment preset={env.preset} background blur={0.55} />

      {/* 4-point lighting — no dark angles */}
      <ambientLight intensity={env.amb} />
      <directionalLight
        position={[8, 16, 6]} intensity={1.5} castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.5} shadow-camera-far={60}
        shadow-camera-left={-10} shadow-camera-right={10}
        shadow-camera-top={13}  shadow-camera-bottom={-2}
      />
      <directionalLight position={[-8, 10, -5]} intensity={0.70} />
      <pointLight position={[0,  10,  0]} intensity={0.55} color="#ffeecc" decay={2} />
      <pointLight position={[5,   2,  5]} intensity={0.30} color="#c4d8ff" decay={2} />
      <pointLight position={[-5,  2, -5]} intensity={0.25} color="#ffddb8" decay={2} />

      <Physics
        key={`phys-${gravity}-${gameIteration}`}
        gravity={[0, gravity, 0]}
        timeStep={1 / 60}
      >
        {/* Floor */}
        <RigidBody type="fixed" colliders="cuboid">
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.01, 0]}>
            <planeGeometry args={[40, 40]} />
            <meshStandardMaterial color={env.floor} roughness={0.92} />
          </mesh>
        </RigidBody>

        {/* Blocks — key includes gameIteration to force remount on rebuild */}
        {blocks.map((b) => (
          <Block
            key={`${b.id}-${gameIteration}`}
            block={b}
            rbRefs={rbRefs}
            thawDelay={thawDelays[b.level]}
            isHost={isHost}
            remoteState={remoteBlockStates[b.id]}
            isInteractable={isMyTurn && !b.removed}
            isSelected={selectedBlock === b.id}
            lockedByColor={lockedBlocks[b.id] ? playerColorMap[lockedBlocks[b.id]] : null}
            onSelect={onSelectBlock}
            controlsRef={controlsRef}
          />
        ))}

        <TowerAnalytics
          rbRefs={rbRefs}
          blocks={blocks}
          totalBlocks={totalBlks}
          onUpdate={onAnalyticsUpdate}
        />
        {isHost && (
          <HostSync rbRefs={rbRefs} blocks={blocks} pushBlockStates={pushBlockStates} />
        )}
      </Physics>

      <ContactShadows position={[0, 0.005, 0]} opacity={0.42} scale={12} blur={2.5} />
      <CameraShake triggerRef={shakeRef} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        minDistance={5}
        maxDistance={22}
        maxPolarAngle={Math.PI / 2 - 0.02}
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── HUD ────────────────────────────────────────────────────────────────────────
function HUDPanel({ analytics, currentTurn, myId, players, isMyTurn }) {
  const { risk, lean, instability } = analytics;
  const turnName = players[currentTurn]?.name ?? currentTurn?.slice(0, 4) ?? "…";
  const riskClr = risk > 65 ? "#ef4444" : risk > 35 ? "#f97316" : "#22c55e";
  const leanClr = lean > 60 ? "#ef4444" : lean > 30 ? "#f97316" : "#3b82f6";

  return (
    <div style={S.hud}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: isMyTurn ? "#4ade80" : "#f0d090" }}>
        {isMyTurn ? "✦ YOUR TURN" : `${turnName}'s turn`}
      </div>

      {[{ label: "Fall Risk", pct: risk, color: riskClr }, { label: "Tower Lean", pct: lean, color: leanClr }].map(({ label, pct, color }) => (
        <div key={label} style={{ marginBottom: 9 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888", marginBottom: 3 }}>
            <span>{label}</span>
            <span style={{ color, fontWeight: 700 }}>{pct}%</span>
          </div>
          <div style={{ height: 6, background: "#1e1e1e", borderRadius: 3 }}>
            <div style={{
              height: "100%", width: `${pct}%`, background: color,
              borderRadius: 3, transition: "width 0.22s",
              boxShadow: pct > 65 ? `0 0 8px ${color}88` : "none",
            }} />
          </div>
        </div>
      ))}

      <div style={{ fontSize: 10, color: "#444" }}>
        Instability index: {(instability * 10).toFixed(1)}
      </div>

      {risk > 65 && (
        <div style={{
          marginTop: 9, padding: "5px 9px",
          background: "rgba(239,68,68,0.12)",
          border: "1px solid rgba(239,68,68,0.28)",
          borderRadius: 6, fontSize: 11, color: "#ef4444",
        }}>
          ⚠ Tower is critical!
        </div>
      )}
    </div>
  );
}

// ── Chat ───────────────────────────────────────────────────────────────────────
function ChatWindow({ chatMsgs, onSend, myId, playerColorMap }) {
  const [input, setInput]   = useState("");
  const bottomRef           = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMsgs]);

  const send = () => {
    if (input.trim()) { onSend(input.trim()); setInput(""); }
  };

  return (
    <div style={S.chat}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#666", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>
        Chat
      </div>
      <div style={{ flex: 1, overflowY: "auto", marginBottom: 6 }}>
        {chatMsgs.length === 0 && (
          <div style={{ fontSize: 11, color: "#333", fontStyle: "italic" }}>No messages yet…</div>
        )}
        {chatMsgs.map((m, i) => (
          <div key={i} style={{ fontSize: 11, margin: "3px 0", lineHeight: 1.45 }}>
            <b style={{ color: playerColorMap[m.authorId] || (m.authorId === myId ? "#4ade80" : "#777") }}>
              {m.name || m.authorId?.slice(0, 4)}:
            </b>{" "}<span style={{ color: "#ccc" }}>{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", gap: 5 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message…"
          style={{ ...S.input, flex: 1 }}
        />
        <button onClick={send} style={{ ...S.btn, width: 36, padding: 0, fontSize: 15, flexShrink: 0 }}>
          ↑
        </button>
      </div>
    </div>
  );
}

// ── Room Settings Modal ────────────────────────────────────────────────────────
function SettingsModal({ settings, onSave, onClose, isHost }) {
  const [loc, setLoc] = useState({ ...settings });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ ...S.glass, width: 290, maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>⚙ Room Settings</div>

        {isHost ? (
          <>
            <label style={S.lbl}>Password <span style={{ color: "#444" }}>(blank = public)</span></label>
            <input
              value={loc.password || ""}
              onChange={(e) => setLoc((p) => ({ ...p, password: e.target.value }))}
              placeholder="Optional password"
              style={S.input}
            />

            <label style={S.lbl}>Gravity strength: {Math.abs(loc.gravity ?? -11).toFixed(1)}</label>
            <input
              type="range" min={-20} max={-4} step={0.5}
              value={loc.gravity ?? -11}
              onChange={(e) => setLoc((p) => ({ ...p, gravity: +e.target.value }))}
              style={{ width: "100%", marginTop: 3 }}
            />

            <label style={S.lbl}>Tower levels: {loc.levels ?? 18}</label>
            <input
              type="range" min={10} max={25} step={1}
              value={loc.levels ?? 18}
              onChange={(e) => setLoc((p) => ({ ...p, levels: +e.target.value }))}
              style={{ width: "100%", marginTop: 3 }}
            />

            <p style={{ fontSize: 10, color: "#555", marginTop: 10 }}>
              Changes apply on next tower rebuild.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => { onSave(loc); onClose(); }} style={S.btn}>Save</button>
              <button onClick={onClose} style={{ ...S.btn, background: "#333", color: "#aaa" }}>Cancel</button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "#777" }}>
            <div style={{ marginBottom: 6 }}>Gravity: {settings.gravity}</div>
            <div style={{ marginBottom: 6 }}>Levels: {settings.levels}</div>
            <div style={{ color: "#555", fontStyle: "italic" }}>Only the host can edit settings.</div>
            <button onClick={onClose} style={{ ...S.btn, marginTop: 14 }}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Match Stats ────────────────────────────────────────────────────────────────
function StatsPanel({ matchStats, myId }) {
  const rows = Object.entries(matchStats).filter(([k]) => k !== "lastCollapse");
  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ fontSize: 10, color: "#555", letterSpacing: 1, textTransform: "uppercase", marginBottom: 7 }}>
        Match Stats
      </div>
      {rows.sort((a, b) => (b[1].removals || 0) - (a[1].removals || 0)).map(([id, s]) => (
        <div key={id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: id === myId ? "#4ade80" : "#666", marginBottom: 3 }}>
          <span>{s.name || id.slice(0, 4)}{id === myId ? " (you)" : ""}</span>
          <span>{s.removals || 0} pulls</span>
        </div>
      ))}
      {matchStats.lastCollapse && (
        <div style={{ marginTop: 6, fontSize: 10, color: "#f87171" }}>
          Last collapse: {matchStats.lastCollapse.blocks} blocks standing
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const [myId]          = useState(() => Math.random().toString(36).slice(2, 10));
  const [blocks,         setBlocks]         = useState(() => buildBlocks());
  const [analytics,      setAnalytics]      = useState({ risk: 0, lean: 0, avgVel: 0, instability: 0 });
  const [selectedBlock,  setSelectedBlock]  = useState(null);
  const [showSettings,   setShowSettings]   = useState(false);
  const [joinMode,       setJoinMode]       = useState(false);
  const [joinCode,       setJoinCode]       = useState("");
  const [joinPass,       setJoinPass]       = useState("");
  const [joinError,      setJoinError]      = useState("");
  const [spectatorJoin,  setSpectatorJoin]  = useState(false);

  const rbRefs   = useRef(new Map());
  const shakeRef = useRef(() => {});
  const controlsRef = useRef(null);
  const prevRisk = useRef(0);

  const { playTap, playPull, playCrash } = useAudio();

  const thawDelays = useMemo(() => {
    const d = {};
    for (let lvl = 0; lvl < DEFAULT_LEVELS; lvl++) d[lvl] = BASE_THAW + lvl * PER_LEVEL;
    return d;
  }, []);

  const {
    roomCode, status, isHost, players, currentTurn, removedIds, lockedBlocks,
    chatMsgs, gameIteration, envType, remoteBlockStates, roomSettings, matchStats, isSpectator,
    createRoom, joinRoom, sendChat, triggerRebuild, changeEnv, updateSettings,
    lockBlock, unlockBlock, removeBlock, pushBlockStates, recordCollapse,
  } = useFirebaseRoom(myId);

  const isMyTurn = currentTurn === myId && !isSpectator;
  const gravity  = roomSettings.gravity ?? -11;

  // Stable player → colour map
  const playerColorMap = useMemo(() => {
    const m = {};
    Object.keys(players).forEach((id, i) => { m[id] = P_COLORS[i % P_COLORS.length]; });
    return m;
  }, [players]);

  // ── Block interaction ──────────────────────────────────────────────────────
  const handleSelectBlock = useCallback((blockId) => {
    if (!isMyTurn) return;
    if (selectedBlock === blockId) {
      removeBlock(blockId);
      setSelectedBlock(null);
      playPull();
    } else {
      if (selectedBlock) unlockBlock(selectedBlock);
      setSelectedBlock(blockId);
      lockBlock(blockId);
      playTap();
    }
  }, [isMyTurn, selectedBlock, removeBlock, lockBlock, unlockBlock, playTap, playPull]);

  // ── Rebuild ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (gameIteration === 0) return;
    setBlocks(buildBlocks(roomSettings.levels ?? DEFAULT_LEVELS));
    setSelectedBlock(null);
  }, [gameIteration, roomSettings.levels]);

  // ── Sync removed blocks ────────────────────────────────────────────────────
  useEffect(() => {
    setBlocks((prev) =>
      prev.map((b) => ({ ...b, removed: removedIds.includes(b.id) })),
    );
  }, [removedIds]);

  // ── Camera shake + collapse detection ─────────────────────────────────────
  useEffect(() => {
    const { risk, avgVel } = analytics;
    if (avgVel > 3 && risk > prevRisk.current) {
      shakeRef.current(Math.min(avgVel * 0.22, 1.0));
      if (avgVel > 8) {
        playCrash();
        recordCollapse(blocks.filter((b) => !b.removed).length);
      }
    }
    prevRisk.current = risk;
  }, [analytics, playCrash, recordCollapse, blocks]);

  // ── Join handler ───────────────────────────────────────────────────────────
  const handleJoin = async () => {
    const res = await joinRoom(joinCode.toUpperCase().trim(), joinPass, spectatorJoin);
    if (res?.error) setJoinError(res.error);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      {/* ── Left Panel ───────────────────────────────────────────────── */}
      <div style={S.panel}>
        <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 6, color: "#f0d090", marginBottom: 16, fontVariant: "small-caps" }}>
          JENGA
        </div>

        {!roomCode ? (
          /* ── Lobby ── */
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button onClick={() => createRoom(makeCode())} style={S.btn}>
              + Create Room
            </button>

            {!joinMode ? (
              <>
                <button onClick={() => { setJoinMode(true); setSpectatorJoin(false); }}
                  style={{ ...S.btn, background: "#1d4ed8", color: "#fff" }}>
                  Join Room
                </button>
                <button onClick={() => { setJoinMode(true); setSpectatorJoin(true); }}
                  style={{ ...S.btn, background: "#1e293b", color: "#94a3b8" }}>
                  👁 Spectate
                </button>
              </>
            ) : (
              <>
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="Room code"
                  style={S.input}
                />
                <input
                  value={joinPass}
                  onChange={(e) => setJoinPass(e.target.value)}
                  placeholder="Password (if required)"
                  type="password"
                  style={S.input}
                />
                {joinError && <div style={{ fontSize: 11, color: "#f87171" }}>{joinError}</div>}
                <button onClick={handleJoin}
                  style={{ ...S.btn, background: spectatorJoin ? "#1e293b" : "#1d4ed8", color: "#fff" }}>
                  {spectatorJoin ? "👁 Join as Spectator" : "Join"}
                </button>
                <button onClick={() => { setJoinMode(false); setJoinError(""); }}
                  style={{ ...S.btn, background: "#222", color: "#666" }}>
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : (
          /* ── In-room ── */
          <>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
              Room{" "}
              <b style={{ color: "#f0d090", letterSpacing: 2 }}>{roomCode}</b>
              {isSpectator && <span style={{ color: "#555", marginLeft: 6 }}>· spectating</span>}
            </div>
            <div style={{ fontSize: 10, color: "#444", marginBottom: 12 }}>
              {Object.keys(players).length} player{Object.keys(players).length !== 1 ? "s" : ""} · {status}
            </div>

            {/* Player list */}
            <div style={{ marginBottom: 12 }}>
              {Object.entries(players).map(([id, p]) => (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, marginBottom: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: playerColorMap[id], flexShrink: 0 }} />
                  <span style={{ color: id === myId ? "#4ade80" : "#888" }}>
                    {p.name || id.slice(0, 4)}
                    {id === myId ? " (you)" : ""}
                    {p.isSpectator ? " 👁" : ""}
                  </span>
                  {currentTurn === id && <span style={{ color: "#f0d090", marginLeft: "auto" }}>◀</span>}
                </div>
              ))}
            </div>

            {/* Environment picker */}
            <label style={S.lbl}>Environment</label>
            <select
              value={envType}
              onChange={(e) => changeEnv(e.target.value)}
              style={{ ...S.input, cursor: "pointer", marginBottom: 10 }}
            >
              {Object.entries(ENVS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>

            {/* Interaction hint */}
            {isMyTurn && selectedBlock && (
              <div style={{
                padding: "6px 10px", marginBottom: 10,
                background: "rgba(74,222,128,0.08)",
                border: "1px solid rgba(74,222,128,0.25)",
                borderRadius: 6, fontSize: 11, color: "#4ade80",
              }}>
                Block selected — click again to pull, or drag it first
              </div>
            )}

            {!isSpectator && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <button onClick={triggerRebuild} style={{ ...S.btn, background: "#7f1d1d", color: "#fca5a5" }}>
                  ↺ Rebuild Tower
                </button>
                <button onClick={() => setShowSettings(true)}
                  style={{ ...S.btn, background: "#1e293b", color: "#94a3b8" }}>
                  ⚙ Room Settings
                </button>
              </div>
            )}

            <StatsPanel matchStats={matchStats} myId={myId} />
          </>
        )}
      </div>

      {/* ── HUD ──────────────────────────────────────────────────────── */}
      <HUDPanel
        analytics={analytics}
        currentTurn={currentTurn}
        myId={myId}
        players={players}
        isMyTurn={isMyTurn}
      />

      {/* ── Chat ─────────────────────────────────────────────────────── */}
      {roomCode && (
        <ChatWindow
          chatMsgs={chatMsgs}
          onSend={sendChat}
          myId={myId}
          playerColorMap={playerColorMap}
        />
      )}

      {/* ── Settings Modal ────────────────────────────────────────────── */}
      {showSettings && (
        <SettingsModal
          settings={roomSettings}
          onSave={updateSettings}
          onClose={() => setShowSettings(false)}
          isHost={isHost}
        />
      )}

      {/* ── 3D Canvas ────────────────────────────────────────────────── */}
      <Canvas
        shadows
        camera={{ position: [7, 9.5, 9], fov: 44 }}
        style={{ position: "absolute", inset: 0, zIndex: 0 }}
      >
        <Scene
          blocks={blocks}
          rbRefs={rbRefs}
          thawDelays={thawDelays}
          gameIteration={gameIteration}
          envType={envType}
          isHost={isHost}
          remoteBlockStates={remoteBlockStates}
          pushBlockStates={pushBlockStates}
          isMyTurn={isMyTurn}
          lockedBlocks={lockedBlocks}
          playerColorMap={playerColorMap}
          selectedBlock={selectedBlock}
          onSelectBlock={handleSelectBlock}
          onAnalyticsUpdate={setAnalytics}
          shakeRef={shakeRef}
          gravity={gravity}
          controlsRef={controlsRef}
        />
      </Canvas>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const glass = {
  background:    "rgba(6,5,3,0.92)",
  backdropFilter: "blur(16px)",
  borderRadius:  10,
  border:        "1px solid rgba(255,255,255,0.08)",
  padding:       14,
  color:         "#fff",
  zIndex:        10,
};

const S = {
  root:  { width: "100vw", height: "100vh", overflow: "hidden", background: "#0d0b08", color: "#fff", fontFamily: "'Segoe UI', system-ui, sans-serif" },
  glass,
  panel: { ...glass, position: "absolute", top: 16, left: 16, width: 230 },
  hud:   { ...glass, position: "absolute", top: 16, right: 16, width: 208 },
  chat:  { ...glass, position: "absolute", bottom: 16, left: 16, width: 230, height: 210, display: "flex", flexDirection: "column" },
  btn:   { width: "100%", padding: "8px 12px", borderRadius: 7, background: "#4ade80", color: "#000", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 12 },
  input: { width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.11)", background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: 12, boxSizing: "border-box" },
  lbl:   { display: "block", fontSize: 10, color: "#555", marginBottom: 4, marginTop: 8, textTransform: "uppercase", letterSpacing: 0.8 },
};