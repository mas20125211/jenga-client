/**
 * Jenga — App.jsx
 *
 * Base: commit 80dad63 (Sam's working version) — spring-force drag, gyroscope
 * stability meter, visual turn timer, per-client physics, solo play.
 *
 * Feature layer ported on top (from the rewrite-wip branch, reconciled to this
 * base + the NaturalMotion APK reference):
 *   - Block interaction: hover highlight, red glow while you drag, ownership
 *     outline in the holder's colour (synced via `locked`)
 *   - 6 selectable environments + two-sided lighting (no dark angles)
 *   - Procedural wood texture (canvas grain/knots) for block realism
 *   - Tower analytics: Lean Meter + Fall Risk (centre-of-mass drift, velocity,
 *     removed-count, pivot offset)
 *   - Room settings modal (gravity / levels / password)
 *   - Spectator mode, in-room chat, match stats, rebuild button
 *   - Camera shake + Web Audio crash/tap/pull SFX on collapse
 *
 * Physics remains per-client (each browser runs its own Rapier sim). Firebase
 * syncs turn / removed / players / locks / chat / settings / stats only — block
 * transforms are NOT synced. Fixing cross-screen desync is a separate task.
 *
 * Firebase schema (rooms/{code}):
 *   hostId    : "playerId"
 *   current   : "playerId"                       ← whose turn
 *   players   : { id: { name, joinedAt, isSpectator } }
 *   removed   : { "b3-1": true }                 ← pulled blocks
 *   locked    : { "b3-1": "playerId" }           ← who is holding a block
 *   chat      : { pushId: { text, authorId, name, time } }
 *   settings  : { gravity, levels, password }
 *   stats     : { id: { name, removals }, lastCollapse: {...} }
 *   envType   : "apartment" | ...
 *   iteration : number                           ← bump to rebuild for everyone
 *   createdAt : number
 *
 * IMPORTANT: Firebase Console → Realtime Database → Rules:
 *   { "rules": { ".read": true, ".write": true } }
 */

import React, {
  Suspense, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Environment, Outlines, ContactShadows, Text } from "@react-three/drei";
import { Physics, RigidBody, CuboidCollider } from "@react-three/rapier";
import { ref, set, onValue, update, push, get } from "firebase/database";
import { db } from "./firebase";
import * as THREE from "three";

// ─── Constants ────────────────────────────────────────────────────────────────
const BW = 1.05;   // block length
const BH = 0.30;   // block height
const BD = 0.34;   // block depth  (3 × BD + 2 × ROW_GAP ≈ BW)

const STACK_GAP     = 0.001;
const ROW_GAP       = 0.003;
const DEFAULT_LEVELS = 18;
const MAX_LEVELS    = 25;
const ROOM_LEN      = 10;
const TURN_SEC      = 60;

// Physics — heavy wood, zero bounce
const DEFAULT_GRAVITY = -11;
const FRICTION    = 0.90;
const RESTITUTION = 0.0;
const LIN_DAMP    = 5.5;
const ANG_DAMP    = 6.0;
const MASS        = 1.8;

// Drag spring
const SPRING_K  = 320;
const MAX_FORCE = 28;
const DRAG_DAMP = 16;

// Stagger thaw so tower settles bottom-up, not all at once
const BASE_THAW = 700;
const PER_LEVEL = 80;
const settleMs  = (levels) => BASE_THAW + levels * PER_LEVEL + 600;

// Player accent colours (round-robin by join order)
const P_COLORS = [
  "#4ade80", "#f472b6", "#60a5fa", "#fb923c",
  "#a78bfa", "#facc15", "#34d399", "#e879f9",
];

// Selectable environments
const ENVS = {
  apartment: { label: "Living Room",  preset: "apartment", bg: "#1a1008", floor: "#1a0e06", amb: 0.60 },
  studio:    { label: "Studio",       preset: "studio",    bg: "#0c0c0c", floor: "#111111", amb: 0.90 },
  night:     { label: "Night City",   preset: "night",     bg: "#05050a", floor: "#0a0a14", amb: 0.30 },
  warehouse: { label: "Garage",       preset: "warehouse", bg: "#0d0c0a", floor: "#1a1a18", amb: 0.50 },
  dawn:      { label: "Rooftop Dawn", preset: "dawn",      bg: "#1a0d05", floor: "#180f06", amb: 0.70 },
  forest:    { label: "Forest Cabin", preset: "forest",    bg: "#050c05", floor: "#0a120a", amb: 0.50 },
};

// ─── Build tower ──────────────────────────────────────────────────────────────
function buildBlocks(levels = DEFAULT_LEVELS) {
  const out = [];
  for (let lvl = 0; lvl < levels; lvl++) {
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
        // original X/Z — used to measure pull distance
        ox: alongX ? 0 : off,
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
const shortName = (id) => `P-${id.slice(0, 4)}`;

// ─── Procedural wood (canvas — colour map + matching bump map) ───────────────────
// Returns { map, bump } so the grain reads as real depth under the lights.
function makeWood() {
  const W = 512, H = 256;
  const col = document.createElement("canvas"); col.width = W; col.height = H;
  const bmp = document.createElement("canvas"); bmp.width = W; bmp.height = H;
  const c = col.getContext("2d"), b = bmp.getContext("2d");

  // Base: warm maple, gradient along the length
  const g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, "#b06a34"); g.addColorStop(0.25, "#caa066");
  g.addColorStop(0.5, "#d8b070"); g.addColorStop(0.75, "#c89456"); g.addColorStop(1, "#b06a34");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  b.fillStyle = "#808080"; b.fillRect(0, 0, W, H); // neutral bump base

  // Long flowing grain lines (drawn into both colour + bump)
  for (let i = 0; i < 70; i++) {
    const dark = 0.04 + Math.random() * 0.16;
    const baseY = Math.random() * H;
    const amp = 3 + Math.random() * 9, freq = 0.004 + Math.random() * 0.01;
    const lw = 0.5 + Math.random() * 1.6;
    c.beginPath(); b.beginPath();
    c.strokeStyle = `rgba(60,30,10,${dark})`; c.lineWidth = lw;
    b.strokeStyle = `rgba(40,40,40,${dark * 1.6})`; b.lineWidth = lw;
    for (let x = 0; x <= W; x += 4) {
      const y = baseY + Math.sin(x * freq + i) * amp;
      if (x === 0) { c.moveTo(x, y); b.moveTo(x, y); } else { c.lineTo(x, y); b.lineTo(x, y); }
    }
    c.stroke(); b.stroke();
  }
  // Fine speckle for a tactile surface
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * W, y = Math.random() * H, a = Math.random() * 0.06;
    c.fillStyle = `rgba(50,25,8,${a})`; c.fillRect(x, y, 1, 1);
    b.fillStyle = `rgba(90,90,90,${a * 2})`; b.fillRect(x, y, 1, 1);
  }
  // A couple of knots
  for (let k = 0; k < 2; k++) {
    const kx = 40 + Math.random() * (W - 80), ky = 20 + Math.random() * (H - 40);
    const rg = c.createRadialGradient(kx, ky, 0, kx, ky, 22);
    rg.addColorStop(0, "rgba(70,35,12,0.8)"); rg.addColorStop(0.5, "rgba(90,50,18,0.3)"); rg.addColorStop(1, "rgba(90,50,18,0)");
    c.fillStyle = rg; c.beginPath(); c.ellipse(kx, ky, 22, 11, Math.random() * Math.PI, 0, Math.PI * 2); c.fill();
  }

  const map  = new THREE.CanvasTexture(col);
  const bump = new THREE.CanvasTexture(bmp);
  for (const t of [map, bump]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
  return { map, bump };
}
let _wood = null;
const wood = () => (_wood ||= makeWood());

// Stable per-block tone variation so the set looks like real, slightly-mismatched
// wood instead of 54 identical clones. Hash the id → small hue/lightness shift.
function tintFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  const r = (h % 100) / 100;                    // 0..1 deterministic
  const light = 0.82 + r * 0.30;                // 0.82..1.12 brightness
  const warm  = 1 + ((h >> 4) % 100) / 100 * 0.12 - 0.06;
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const base = [212, 146, 78];                  // #d4924e
  return `rgb(${cl(base[0] * light * warm)},${cl(base[1] * light)},${cl(base[2] * light / warm)})`;
}

// ─── Web Audio SFX (no external files) ─────────────────────────────────────────
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
      const src = ctx.createBufferSource(), filt = ctx.createBiquadFilter(), gain = ctx.createGain();
      filt.type = "bandpass"; filt.frequency.value = 950; filt.Q.value = 3.5;
      src.buffer = buf; src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.38, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.11);
      src.start();
    } catch { /* audio not ready */ }
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
    } catch { /* audio not ready */ }
  }, []);
  const playCrash = useCallback(() => {
    try {
      const ctx = resume();
      const buf = ctx.createBuffer(1, ~~(ctx.sampleRate * 1.1), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.38));
      const src = ctx.createBufferSource(), filt = ctx.createBiquadFilter(), gain = ctx.createGain();
      filt.type = "lowpass"; filt.frequency.value = 380;
      src.buffer = buf; src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.95, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.1);
      src.start();
    } catch { /* audio not ready */ }
  }, []);
  return { playTap, playPull, playCrash };
}

// ─── Gyro hook (phone stability meter) ──────────────────────────────────────────
function useGyro() {
  const [stab, setStab]      = useState(100);
  const [needsBtn, setNeeds] = useState(false);
  const prev = useRef({ a: 0, b: 0, g: 0 });

  useEffect(() => {
    const t = setInterval(() => setStab(s => clamp(s + 0.5, 0, 100)), 80);
    return () => clearInterval(t);
  }, []);

  const attach = useCallback(() => {
    const h = (e) => {
      const a = e.rotationRate?.alpha ?? 0;
      const b = e.rotationRate?.beta  ?? 0;
      const g = e.rotationRate?.gamma ?? 0;
      const d = Math.abs(a - prev.current.a) + Math.abs(b - prev.current.b) + Math.abs(g - prev.current.g);
      if (d > 0.4) setStab(s => clamp(s - d * 0.09, 0, 100));
      prev.current = { a, b, g };
    };
    window.addEventListener("devicemotion", h, true);
    return () => window.removeEventListener("devicemotion", h, true);
  }, []);

  useEffect(() => {
    if (typeof DeviceMotionEvent === "undefined") return;
    if (typeof DeviceMotionEvent.requestPermission === "function") setNeeds(true); // iOS gesture
    else return attach();                                                          // Android/desktop
  }, [attach]);

  const requestGyro = useCallback(async () => {
    try {
      if ((await DeviceMotionEvent.requestPermission()) === "granted") { attach(); setNeeds(false); }
    } catch { /* denied */ }
  }, [attach]);

  return { stab, needsBtn, requestGyro };
}

// ─── Firebase room hook ─────────────────────────────────────────────────────────
function useFirebaseRoom(myId) {
  const unsubRef      = useRef(null);
  const blockUnsubRef = useRef(null);
  const snapRef       = useRef(null);     // latest snapshot mirror
  const remoteRef     = useRef({});       // live block transforms from the authority
                                          // (kept in a ref — updates ~15fps, never re-renders)

  const [roomCode,     setRoomCode]     = useState("");
  const [status,       setStatus]       = useState("local");
  const [isHost,       setIsHost]       = useState(false);
  const [players,      setPlayers]      = useState({});
  const [currentTurn,  setCurrentTurn]  = useState(null);
  const [removedIds,   setRemovedIds]   = useState([]);
  const [lockedBlocks, setLockedBlocks] = useState({});
  const [chatMsgs,     setChatMsgs]     = useState([]);
  const [gameIteration, setGameIteration] = useState(0);
  const [envType,      setEnvType]      = useState("apartment");
  const [roomSettings, setRoomSettings] = useState({ gravity: DEFAULT_GRAVITY, levels: DEFAULT_LEVELS, password: "" });
  const [matchStats,   setMatchStats]   = useState({});
  const [isSpectator,  setIsSpectator]  = useState(false);

  const applySnapshot = useCallback((data) => {
    snapRef.current = data;
    if (data.current) setCurrentTurn(data.current);
    setPlayers(data.players || {});
    setRemovedIds(data.removed ? Object.keys(data.removed) : []);
    setLockedBlocks(data.locked || {});
    setChatMsgs(data.chat ? Object.values(data.chat).sort((a, b) => a.time - b.time) : []);
    setGameIteration(data.iteration || 0);
    setEnvType(data.envType || "apartment");
    if (data.settings) setRoomSettings((s) => ({ ...s, ...data.settings }));
    setMatchStats(data.stats || {});
  }, []);

  const subscribe = useCallback((code) => {
    unsubRef.current?.();
    blockUnsubRef.current?.();
    setStatus("connecting");
    const unsub = onValue(ref(db, `rooms/${code}`), (snap) => {
      const data = snap.val();
      if (!data) { setStatus("not found"); return; }
      setStatus("online");
      applySnapshot(data);
    });
    unsubRef.current = unsub;
    // Separate high-frequency channel for block transforms — kept out of the
    // room object so a 15fps physics broadcast never re-renders React.
    blockUnsubRef.current = onValue(ref(db, `blockStates/${code}`), (snap) => {
      remoteRef.current = snap.val() || {};
    });
  }, [applySnapshot]);

  // Turn order: non-spectators, sorted by joinedAt
  const turnOrder = (data) =>
    Object.entries(data?.players || {})
      .filter(([, p]) => p && !p.isSpectator)
      .sort(([, a], [, b]) => (a.joinedAt || 0) - (b.joinedAt || 0))
      .map(([id]) => id);

  const createRoom = useCallback((code, name = "", extraSettings = {}) => {
    const settings = { gravity: DEFAULT_GRAVITY, levels: DEFAULT_LEVELS, password: "", ...extraSettings };
    set(ref(db, `rooms/${code}`), {
      hostId: myId, current: myId, name: name || `${shortName(myId)}'s table`,
      players: { [myId]: { name: shortName(myId), joinedAt: Date.now(), isSpectator: false } },
      removed: {}, locked: {}, chat: {},
      iteration: 0, envType: "apartment", settings, stats: {}, createdAt: Date.now(),
    });
    setRoomCode(code); setIsHost(true); setIsSpectator(false);
    setRoomSettings(settings);
    subscribe(code);
  }, [myId, subscribe]);

  const joinRoom = useCallback(async (code, password = "", spectator = false) => {
    const snap = await get(ref(db, `rooms/${code}`));
    const data = snap.val();
    if (!data) return { error: "Room not found" };
    if (data.settings?.password && data.settings.password !== password)
      return { error: "Incorrect password" };
    await update(ref(db, `rooms/${code}`), {
      [`players/${myId}`]: { name: shortName(myId), joinedAt: Date.now(), isSpectator: spectator },
    });
    setRoomCode(code); setIsHost(data.hostId === myId); setIsSpectator(spectator);
    subscribe(code);
    return { success: true };
  }, [myId, subscribe]);

  const leaveRoom = useCallback(() => {
    unsubRef.current?.(); unsubRef.current = null;
    blockUnsubRef.current?.(); blockUnsubRef.current = null;
    if (roomCode) update(ref(db, `rooms/${roomCode}`), { [`players/${myId}`]: null });
    setRoomCode(""); setStatus("local"); setIsHost(false); setIsSpectator(false);
    setPlayers({}); setCurrentTurn(null); setRemovedIds([]); setLockedBlocks({});
    setChatMsgs([]); setMatchStats({}); snapRef.current = null; remoteRef.current = {};
  }, [roomCode, myId]);

  // Authority (turn-holder) broadcasts moved block transforms ~15fps.
  const pushBlockStates = useCallback((states) => {
    if (roomCode) update(ref(db, `blockStates/${roomCode}`), states);
  }, [roomCode]);

  const emitPulled = useCallback((blockId) => {
    const data = snapRef.current;
    if (!data || !roomCode) return;
    const order  = turnOrder(data);
    const idx    = order.indexOf(data.current ?? myId);
    const nextId = order[(idx + 1) % order.length] ?? myId;
    const prevRemovals = data.stats?.[myId]?.removals || 0;
    update(ref(db, `rooms/${roomCode}`), {
      [`removed/${blockId}`]: true,
      [`locked/${blockId}`]:  null,
      current: nextId,
      [`stats/${myId}/removals`]: prevRemovals + 1,
      [`stats/${myId}/name`]:     shortName(myId),
    });
  }, [roomCode, myId]);

  const lockBlock   = useCallback((id) => { if (roomCode) update(ref(db, `rooms/${roomCode}/locked`), { [id]: myId }); }, [roomCode, myId]);
  const unlockBlock = useCallback((id) => { if (roomCode) update(ref(db, `rooms/${roomCode}/locked`), { [id]: null }); }, [roomCode]);

  const sendChat = useCallback((text) => {
    if (!roomCode) return;
    push(ref(db, `rooms/${roomCode}/chat`), { text, authorId: myId, name: shortName(myId), time: Date.now() });
  }, [roomCode, myId]);

  const triggerRebuild = useCallback(() => {
    if (!roomCode) return;
    set(ref(db, `blockStates/${roomCode}`), null);  // drop stale transforms
    remoteRef.current = {};
    update(ref(db, `rooms/${roomCode}`), {
      removed: {}, locked: {},
      iteration: (snapRef.current?.iteration || 0) + 1,
      current: turnOrder(snapRef.current)[0] || myId,
    });
  }, [roomCode, myId]);

  const changeEnv      = useCallback((type) => { if (roomCode) update(ref(db, `rooms/${roomCode}`), { envType: type }); }, [roomCode]);
  const updateSettings = useCallback((settings) => {
    if (roomCode) update(ref(db, `rooms/${roomCode}`), { settings });
    else setRoomSettings((s) => ({ ...s, ...settings }));
  }, [roomCode]);

  const recordCollapse = useCallback((blockCount) => {
    if (roomCode) update(ref(db, `rooms/${roomCode}/stats`), {
      lastCollapse: { blocks: blockCount, at: Date.now(), causedBy: currentTurn },
    });
  }, [roomCode, currentTurn]);

  useEffect(() => () => unsubRef.current?.(), []);

  return {
    roomCode, status, isHost, players, currentTurn, removedIds, lockedBlocks,
    chatMsgs, gameIteration, envType, roomSettings, matchStats, isSpectator, remoteRef,
    createRoom, joinRoom, leaveRoom, emitPulled, lockBlock, unlockBlock,
    sendChat, triggerRebuild, changeEnv, updateSettings, recordCollapse, pushBlockStates,
  };
}

// ─── Block component ─────────────────────────────────────────────────────────────
// Physics authority model: the turn-holder (or any solo player) runs the block
// dynamically and broadcasts its transform. Everyone else keeps the block
// kinematic and mirrors the broadcast each frame, so all towers are identical.
const Block = React.memo(function Block({
  block, rbRefs, thawDelay, interactable, lockedByColor, isMineDragging,
  isAuthority, remoteRef,
}) {
  const rbRef   = useRef(null);
  const meshRef = useRef(null);
  const [hov, setHov] = useState(false);
  const { map, bump } = wood();
  const tint = useMemo(() => tintFor(block.id), [block.id]);

  useEffect(() => {
    if (rbRef.current) rbRefs.current.set(block.id, rbRef.current);
    return () => rbRefs.current.delete(block.id);
  }, [block.id, rbRefs]);

  useEffect(() => { if (meshRef.current) meshRef.current.userData.blockId = block.id; }, [block.id]);

  // Every block stays DYNAMIC for everyone — we never switch body types (doing
  // so mid-turn-change was calling kinematic methods on a dynamic body and
  // crashing Rapier → black screen). Thaw to dynamic once after the settle.
  useEffect(() => {
    const t = setTimeout(() => rbRef.current?.setBodyType(0), thawDelay);
    return () => clearTimeout(t);
  }, [thawDelay]);

  // Non-authority clients hard-snap each block to the authority's broadcast
  // every frame (teleport + zero velocity). setTranslation/setRotation are safe
  // on dynamic bodies, so there's no type switch and no crash — and every piece
  // tracks the authority exactly, so the towers stay identical.
  useFrame(() => {
    if (isAuthority) return;
    const rb = rbRef.current;
    const rs = remoteRef?.current?.[block.id];
    if (!rb || !rs) return;
    rb.setTranslation({ x: rs.px, y: rs.py, z: rs.pz }, true);
    rb.setRotation({ x: rs.rx, y: rs.ry, z: rs.rz, w: rs.rw ?? 1 }, true);
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  });

  if (block.removed) return null;

  const canHover = interactable && !lockedByColor;
  // Highlight priority: I'm holding it (bright gold) → someone else holds it
  // (their colour) → I'm hovering a pullable one (amber). Made deliberately
  // loud so it's unmistakable which block you're about to pull.
  const grabbed = isMineDragging;
  const showOutline = grabbed || !!lockedByColor || (hov && canHover);
  const outlineClr  = grabbed ? "#ffe24a" : lockedByColor ?? "#fff2c0";
  const outlineW    = grabbed ? 0.05 : lockedByColor ? 0.03 : 0.025;
  const emissive    = grabbed ? "#ffb020" : lockedByColor ? lockedByColor : (hov && canHover ? "#ff8c2a" : "#000000");
  const emissiveI   = grabbed ? 0.9 : lockedByColor ? 0.35 : (hov && canHover ? 0.45 : 0);

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
      <CuboidCollider args={[BW / 2 - 0.002, BH / 2 - 0.002, BD / 2 - 0.002]} friction={FRICTION} restitution={RESTITUTION} />
      <mesh
        ref={meshRef}
        castShadow receiveShadow
        onPointerOver={(e) => { e.stopPropagation(); setHov(true); if (canHover) document.body.style.cursor = "grab"; }}
        onPointerOut={(e)  => { e.stopPropagation(); setHov(false); document.body.style.cursor = "default"; }}
      >
        <boxGeometry args={[BW, BH, BD]} />
        <meshStandardMaterial
          map={map}
          bumpMap={bump}
          bumpScale={0.6}
          color={tint}
          emissive={emissive}
          emissiveIntensity={emissiveI}
          roughness={0.62}
          metalness={0.0}
          envMapIntensity={0.7}
        />
        {showOutline && <Outlines thickness={outlineW} color={outlineClr} />}
      </mesh>
    </RigidBody>
  );
});

// ─── Drag controller (spring-force pull) ────────────────────────────────────────
function DragController({ rbRefs, blocks, settled, active, onGrab, onRelease, setOrbitEnabled, stabRef }) {
  const { camera, gl, scene } = useThree();
  const drag     = useRef(null);
  const ptr      = useRef(new THREE.Vector2());
  const ray      = useRef(new THREE.Raycaster());
  const hitPt    = useRef(new THREE.Vector3());
  const blockMap = useRef({});

  useEffect(() => { blockMap.current = Object.fromEntries(blocks.map(b => [b.id, b])); }, [blocks]);

  const toNDC = useCallback((cx, cy) => {
    const r = gl.domElement.getBoundingClientRect();
    ptr.current.set(((cx - r.left) / r.width) * 2 - 1, ((cy - r.top) / r.height) * -2 + 1);
  }, [gl]);

  const onDown = useCallback((e) => {
    if (!active || !settled) return;
    const cx = e.touches?.[0]?.clientX ?? e.clientX;
    const cy = e.touches?.[0]?.clientY ?? e.clientY;
    toNDC(cx, cy);
    ray.current.setFromCamera(ptr.current, camera);

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

    rb.wakeUp(); rb.setBodyType(0);
    const pos  = rb.translation();
    const norm = new THREE.Vector3(camera.position.x - pos.x, 0, camera.position.z - pos.z).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(norm, new THREE.Vector3(pos.x, pos.y, pos.z));

    drag.current = { blockId, rb, ox: block.ox, oz: block.oz, plane };
    setOrbitEnabled(false);
    onGrab?.(blockId);
    e.preventDefault?.();
  }, [active, settled, camera, scene, rbRefs, toNDC, setOrbitEnabled, onGrab]);

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
    if (!rb) { onRelease?.(blockId, false); return; }
    const pos  = rb.translation();
    const dist = Math.hypot(pos.x - ox, pos.z - oz);
    onRelease?.(blockId, dist > BW * 0.62);
  }, [onRelease, setOrbitEnabled]);

  useEffect(() => {
    const el = gl.domElement, opts = { passive: false };
    el.addEventListener("pointerdown", onDown, opts);
    el.addEventListener("pointermove", onMove, opts);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("touchstart", onDown, opts);
    el.addEventListener("touchmove", onMove, opts);
    el.addEventListener("touchend", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("touchstart", onDown);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onUp);
    };
  }, [gl, onDown, onMove, onUp]);

  useFrame(() => {
    if (!drag.current) return;
    const { rb, plane } = drag.current;
    ray.current.setFromCamera(ptr.current, camera);
    if (!ray.current.ray.intersectPlane(plane, hitPt.current)) return;
    const pos = rb.translation(), vel = rb.linvel();
    // Pull toward the full 3-D pointer target — X, Z AND Y. Following the
    // vertical too means a careless yank lifts/tilts the block so it scrapes
    // and shoves its neighbours, instead of sliding out on a clean rail.
    const dx = hitPt.current.x - pos.x;
    const dy = hitPt.current.y - pos.y;
    const dz = hitPt.current.z - pos.z;
    let fx = dx * SPRING_K - vel.x * DRAG_DAMP;
    let fy = dy * SPRING_K * 0.7 - vel.y * DRAG_DAMP;
    let fz = dz * SPRING_K - vel.z * DRAG_DAMP;

    // Gyro: shaky hands (low stability) add random hand-tremor to the pull, so
    // an unsteady phone makes a clean extraction much harder — real Jenga nerves.
    const stab = stabRef?.current ?? 100;
    const wob = (100 - stab) / 100;            // 0 steady … 1 shaking
    if (wob > 0.02) {
      const J = wob * 9;
      fx += (Math.random() - 0.5) * J;
      fy += (Math.random() - 0.5) * J * 0.6;
      fz += (Math.random() - 0.5) * J;
    }

    const mag = Math.hypot(fx, fy, fz);
    if (mag > MAX_FORCE) { const s = MAX_FORCE / mag; fx *= s; fy *= s; fz *= s; }
    rb.applyImpulse({ x: fx * 0.016, y: fy * 0.016, z: fz * 0.016 }, true);
    rb.wakeUp();
  });

  return null;
}

// ─── Tower analytics (Lean + Fall Risk) ─────────────────────────────────────────
// Fall Risk borrows the NaturalMotion pivot idea: how far the centre of mass has
// drifted from the tower's base footprint, blended with motion + removed count.
function TowerAnalytics({ rbRefs, blocks, totalBlocks, onUpdate }) {
  const velHistory = useRef([]);
  useFrame(() => {
    let sumX = 0, sumZ = 0, sumVel = 0, living = 0, dyn = 0;
    blocks.forEach((b) => {
      if (b.removed) return;
      const rb = rbRefs.current.get(b.id);
      if (!rb) return;
      const p = rb.translation();
      sumX += p.x; sumZ += p.z; living++;
      if (rb.bodyType() === 0) { const v = rb.linvel(); sumVel += Math.hypot(v.x, v.y, v.z); dyn++; }
    });
    if (!living) return;

    const drift  = Math.hypot(sumX / living, sumZ / living);  // CoM offset from centre = pivot drift
    const avgVel = dyn > 0 ? sumVel / dyn : 0;
    const leanF   = Math.min(drift / 0.35, 1);
    const velF    = Math.min(avgVel / 2.5, 1);
    const removeF = Math.min((1 - living / totalBlocks) / 0.6, 1);
    const risk = Math.round((leanF * 0.40 + velF * 0.40 + removeF * 0.20) * 100);
    const lean = Math.round(leanF * 100);

    velHistory.current.push(avgVel);
    if (velHistory.current.length > 30) velHistory.current.shift();
    const instability = velHistory.current.slice(-10).reduce((a, b) => a + b, 0) / 10;

    onUpdate({ risk, lean, avgVel, instability });
  });
  return null;
}

// ─── Camera shake ───────────────────────────────────────────────────────────────
function CameraShake({ triggerRef }) {
  const { camera } = useThree();
  const intensity = useRef(0);
  useEffect(() => { triggerRef.current = (v) => { intensity.current = v; }; }, [triggerRef]);
  useFrame(() => {
    if (intensity.current < 0.002) return;
    camera.position.x += (Math.random() - 0.5) * intensity.current * 0.14;
    camera.position.y += (Math.random() - 0.5) * intensity.current * 0.07;
    intensity.current *= 0.87;
  });
  return null;
}

// ─── Floor ──────────────────────────────────────────────────────────────────────
function Table({ color }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.01, 0]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color={color} roughness={0.95} />
      </mesh>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[20, 0.1, 20]} position={[0, -0.12, 0]} friction={0.98} restitution={0.0} />
      </RigidBody>
    </>
  );
}

// ─── Authority physics broadcaster (turn-holder → everyone, ~15fps) ─────────────
function AuthoritySync({ rbRefs, blocks, isAuthority, pushBlockStates }) {
  const frame = useRef(0);
  const last  = useRef({});
  useFrame(() => {
    if (!isAuthority) return;
    if (++frame.current < 4) return;       // ~15fps at 60fps
    frame.current = 0;
    const states = {};
    let changed = false;
    blocks.forEach((b) => {
      if (b.removed) return;
      const rb = rbRefs.current.get(b.id);
      if (!rb || rb.bodyType() !== 0) return; // only live dynamic bricks
      const p = rb.translation(), r = rb.rotation();
      const ns = {
        px: +p.x.toFixed(3), py: +p.y.toFixed(3), pz: +p.z.toFixed(3),
        rx: +r.x.toFixed(4), ry: +r.y.toFixed(4), rz: +r.z.toFixed(4), rw: +r.w.toFixed(4),
      };
      const ls = last.current[b.id];
      if (!ls || Math.abs(ns.px - ls.px) > 0.002 || Math.abs(ns.py - ls.py) > 0.002 ||
          Math.abs(ns.pz - ls.pz) > 0.002 || Math.abs(ns.ry - ls.ry) > 0.003) {
        states[b.id] = ns; last.current[b.id] = ns; changed = true;
      }
    });
    if (changed) pushBlockStates(states);
  });
  return null;
}

// ─── 3-D scene ────────────────────────────────────────────────────────────────
function Scene({
  blocks, rbRefs, thawDelays, settled, gameIteration, gravity, levels,
  envType, active, lockedBlocks, playerColorMap, myId, draggingId,
  onGrab, onRelease, onAnalyticsUpdate, shakeRef, orbitEnabled, setOrbitEnabled, stabRef,
  isAuthority, remoteRef, pushBlockStates,
}) {
  const env = ENVS[envType] || ENVS.apartment;
  const ctrlRef = useRef(null);
  useEffect(() => { if (ctrlRef.current) ctrlRef.current.enabled = orbitEnabled; }, [orbitEnabled]);
  const topY = BH / 2 + levels * (BH + STACK_GAP) + 0.6;

  return (
    <>
      <color attach="background" args={[env.bg]} />
      <fog attach="fog" args={[env.bg, 18, 48]} />
      {/* Wrapped so a slow/unavailable HDR never suspends the whole scene
          (which would freeze the physics frameloop and blank the canvas). */}
      <Suspense fallback={null}>
        <Environment preset={env.preset} background blur={0.55} />
      </Suspense>

      {/* Two-sided lighting — no dark angles */}
      <ambientLight intensity={env.amb} />
      <directionalLight
        position={[9, 16, 7]} intensity={1.6} castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.5} shadow-camera-far={55}
        shadow-camera-left={-9} shadow-camera-right={9}
        shadow-camera-top={13} shadow-camera-bottom={-3}
      />
      <directionalLight position={[-8, 10, -5]} intensity={0.7} />
      <pointLight position={[0, 10, 0]} intensity={0.5} color="#ffeecc" decay={2} />
      <pointLight position={[5, 2, 5]} intensity={0.3} color="#c4d8ff" decay={2} />
      <pointLight position={[-5, 2, -5]} intensity={0.25} color="#ffddb8" decay={2} />

      <Physics
        key={`phys-${gravity}-${gameIteration}-${levels}`}
        gravity={[0, gravity, 0]}
        timeStep={1 / 60}
        colliders={false}
        numSolverIterations={14}
        numAdditionalFrictionIterations={8}
      >
        <Table color={env.floor} />
        {blocks.map((b) => (
          <Block
            key={`${b.id}-${gameIteration}`}
            block={b}
            rbRefs={rbRefs}
            thawDelay={thawDelays[b.level] ?? BASE_THAW}
            interactable={active && !b.removed}
            lockedByColor={lockedBlocks[b.id] && lockedBlocks[b.id] !== myId ? (playerColorMap[lockedBlocks[b.id]] || "#ffffff") : null}
            isMineDragging={draggingId === b.id}
            isAuthority={isAuthority}
            remoteRef={remoteRef}
          />
        ))}
        <DragController
          rbRefs={rbRefs}
          blocks={blocks}
          settled={settled}
          active={active}
          onGrab={onGrab}
          onRelease={onRelease}
          setOrbitEnabled={setOrbitEnabled}
          stabRef={stabRef}
        />
        <AuthoritySync rbRefs={rbRefs} blocks={blocks} isAuthority={isAuthority} pushBlockStates={pushBlockStates} />
        <TowerAnalytics rbRefs={rbRefs} blocks={blocks} totalBlocks={blocks.length} onUpdate={onAnalyticsUpdate} />
      </Physics>

      <ContactShadows position={[0, 0.005, 0]} opacity={0.42} scale={12} blur={2.5} />
      <CameraShake triggerRef={shakeRef} />
      <Text position={[0, topY, 0]} fontSize={0.25} color="#f0d090" anchorX="center">JENGA</Text>
      <OrbitControls ref={ctrlRef} makeDefault enablePan={false} minDistance={5} maxDistance={22} maxPolarAngle={Math.PI / 2.05} />
    </>
  );
}

// ─── HUD (bottom-right) ─────────────────────────────────────────────────────────
function MeterBar({ label, val, color }) {
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888", marginBottom: 3 }}>
        <span>{label}</span><span style={{ color, fontWeight: 700 }}>{val}%</span>
      </div>
      <div style={{ height: 6, background: "#1e1e1e", borderRadius: 3 }}>
        <div style={{ height: "100%", width: `${val}%`, background: color, borderRadius: 3, transition: "width 0.22s", boxShadow: val > 65 ? `0 0 8px ${color}88` : "none" }} />
      </div>
    </div>
  );
}

function HUD({ analytics, stab, needsBtn, requestGyro, myTurn, timeLeft, settled, turnName, onCollapse }) {
  const { risk, lean, instability } = analytics;
  const pct = Math.round(stab);
  const stabClr = pct > 66 ? "#4ade80" : pct > 33 ? "#fbbf24" : "#f87171";
  const riskClr = risk > 65 ? "#ef4444" : risk > 35 ? "#f97316" : "#22c55e";
  const leanClr = lean > 60 ? "#ef4444" : lean > 30 ? "#f97316" : "#3b82f6";

  return (
    <div style={hud}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: myTurn ? "#4ade80" : "#f0d090", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{myTurn ? "✦ YOUR TURN" : `${turnName}'s turn`}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: timeLeft < 8 ? "#f87171" : "#aaa", fontWeight: 800 }}>{timeLeft}s</span>
          <button style={collapseBtn} onClick={onCollapse} title="Collapse">›</button>
        </span>
      </div>
      <MeterBar label="Fall Risk" val={risk} color={riskClr} />
      <MeterBar label="Tower Lean" val={lean} color={leanClr} />
      <MeterBar label="Hand Stability" val={pct} color={stabClr} />
      <div style={{ fontSize: 10, color: "#444" }}>Instability index: {(instability * 10).toFixed(1)}</div>
      {needsBtn && <button style={gyroBtn} onClick={requestGyro}>📱 Enable gyro (iOS)</button>}
      {risk > 65 && (
        <div style={{ marginTop: 9, padding: "5px 9px", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.28)", borderRadius: 6, fontSize: 11, color: "#ef4444" }}>
          ⚠ Tower is critical!
        </div>
      )}
      <div style={hint}>{!settled ? "Tower settling…" : myTurn ? "Drag any block in any direction." : "Wait for your turn."}</div>
    </div>
  );
}

// ─── Chat ────────────────────────────────────────────────────────────────────────
function ChatWindow({ chatMsgs, onSend, myId, playerColorMap }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMsgs]);
  const send = () => { if (input.trim()) { onSend(input.trim()); setInput(""); } };
  return (
    <div style={chat}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#666", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>Chat</div>
      <div style={{ flex: 1, overflowY: "auto", marginBottom: 6 }}>
        {chatMsgs.length === 0 && <div style={{ fontSize: 11, color: "#333", fontStyle: "italic" }}>No messages yet…</div>}
        {chatMsgs.map((m, i) => (
          <div key={i} style={{ fontSize: 11, margin: "3px 0", lineHeight: 1.45 }}>
            <b style={{ color: playerColorMap[m.authorId] || (m.authorId === myId ? "#4ade80" : "#777") }}>{m.name || m.authorId?.slice(0, 4)}:</b>{" "}
            <span style={{ color: "#ccc" }}>{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", gap: 5 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Message…" style={{ ...inp, flex: 1, letterSpacing: 0 }} />
        <button onClick={send} style={{ ...btn, width: 36, padding: 0, fontSize: 15, flexShrink: 0 }}>↑</button>
      </div>
    </div>
  );
}

// ─── Settings modal ──────────────────────────────────────────────────────────────
function SettingsModal({ settings, onSave, onClose, isHost }) {
  const [loc, setLoc] = useState({ ...settings });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ ...glass, width: 290, maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>⚙ Room Settings</div>
        {isHost ? (
          <>
            <label style={lbl}>Password <span style={{ color: "#444" }}>(blank = public)</span></label>
            <input value={loc.password || ""} onChange={(e) => setLoc((p) => ({ ...p, password: e.target.value }))} placeholder="Optional password" style={{ ...inp, letterSpacing: 0 }} />
            <label style={lbl}>Gravity strength: {Math.abs(loc.gravity ?? DEFAULT_GRAVITY).toFixed(1)}</label>
            <input type="range" min={-20} max={-4} step={0.5} value={loc.gravity ?? DEFAULT_GRAVITY} onChange={(e) => setLoc((p) => ({ ...p, gravity: +e.target.value }))} style={{ width: "100%", marginTop: 3 }} />
            <label style={lbl}>Tower levels: {loc.levels ?? DEFAULT_LEVELS}</label>
            <input type="range" min={10} max={MAX_LEVELS} step={1} value={loc.levels ?? DEFAULT_LEVELS} onChange={(e) => setLoc((p) => ({ ...p, levels: +e.target.value }))} style={{ width: "100%", marginTop: 3 }} />
            <p style={{ fontSize: 10, color: "#555", marginTop: 10 }}>Changes apply on next tower rebuild.</p>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => { onSave(loc); onClose(); }} style={btn}>Save</button>
              <button onClick={onClose} style={{ ...btn, background: "#333", color: "#aaa" }}>Cancel</button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "#777" }}>
            <div style={{ marginBottom: 6 }}>Gravity: {settings.gravity}</div>
            <div style={{ marginBottom: 6 }}>Levels: {settings.levels}</div>
            <div style={{ color: "#555", fontStyle: "italic" }}>Only the host can edit settings.</div>
            <button onClick={onClose} style={{ ...btn, marginTop: 14 }}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Match stats ─────────────────────────────────────────────────────────────────
function StatsPanel({ matchStats, myId }) {
  const rows = Object.entries(matchStats).filter(([k]) => k !== "lastCollapse");
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
      <div style={{ fontSize: 10, color: "#555", letterSpacing: 1, textTransform: "uppercase", marginBottom: 7 }}>Match Stats</div>
      {rows.sort((a, b) => (b[1].removals || 0) - (a[1].removals || 0)).map(([id, s]) => (
        <div key={id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: id === myId ? "#4ade80" : "#666", marginBottom: 3 }}>
          <span>{s.name || id.slice(0, 4)}{id === myId ? " (you)" : ""}</span><span>{s.removals || 0} pulls</span>
        </div>
      ))}
      {matchStats.lastCollapse && <div style={{ marginTop: 6, fontSize: 10, color: "#f87171" }}>Last collapse: {matchStats.lastCollapse.blocks} blocks standing</div>}
    </div>
  );
}

// ─── Control panel (top-left) ────────────────────────────────────────────────────
function Panel({
  roomCode, status, myId, players, currentTurn, isSpectator,
  envType, matchStats, playerColorMap,
  onCreate, onJoin, onLeave, onChangeEnv, onRebuild, onOpenSettings, onCollapse,
}) {
  const [mode, setMode]   = useState(null); // null | "join" | "spectate"
  const [code, setCode]   = useState("");
  const [pass, setPass]   = useState("");
  const [err, setErr]     = useState("");
  const inRoom = Boolean(roomCode);

  const doJoin = async () => {
    const c = code.trim().toUpperCase();
    if (c.length !== ROOM_LEN) { setErr(`Code must be ${ROOM_LEN} characters`); return; }
    const res = await onJoin(c, pass, mode === "spectate");
    if (res?.error) setErr(res.error);
  };

  return (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={ptitle}>JENGA</div>
        <button style={collapseBtn} onClick={onCollapse} title="Collapse">‹</button>
      </div>
      <div style={psub}>Worldwide · Firebase · Real Physics</div>

      {!inRoom ? (
        <div style={sec}>
          <button style={btn} onClick={onCreate}>+ Create Room</button>
          {!mode ? (
            <>
              <button style={{ ...btn, background: "#1d4ed8", color: "#fff" }} onClick={() => { setMode("join"); setErr(""); }}>Join Room</button>
              <button style={{ ...btn, background: "#1e293b", color: "#94a3b8" }} onClick={() => { setMode("spectate"); setErr(""); }}>👁 Spectate</button>
            </>
          ) : (
            <>
              <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase().slice(0, ROOM_LEN)); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && doJoin()} placeholder="Room code" maxLength={ROOM_LEN} style={inp} />
              <input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Password (if required)" type="password" style={{ ...inp, letterSpacing: 0 }} />
              {err && <div style={{ color: "#f87171", fontSize: 11 }}>{err}</div>}
              <button style={{ ...btn, background: mode === "spectate" ? "#1e293b" : "#1d4ed8", color: "#fff" }} onClick={doJoin}>{mode === "spectate" ? "👁 Join as Spectator" : "Join"}</button>
              <button style={{ ...btn, background: "#222", color: "#666" }} onClick={() => { setMode(null); setErr(""); }}>Cancel</button>
            </>
          )}
        </div>
      ) : (
        <div style={sec}>
          <div style={sr}><span style={dim}>Room</span><b style={{ letterSpacing: "0.18em", color: "#f0d090", fontSize: 18 }}>{roomCode}</b></div>
          <div style={sr}><span style={dim}>Status</span><b style={{ color: status === "online" ? "#4ade80" : "#fbbf24" }}>{status}{isSpectator ? " · 👁" : ""}</b></div>

          <div style={{ marginTop: 4 }}>
            {Object.entries(players).map(([id, p]) => (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, marginBottom: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: playerColorMap[id], flexShrink: 0 }} />
                <span style={{ color: id === myId ? "#4ade80" : "#aaa" }}>{p.name || id.slice(0, 4)}{id === myId ? " (you)" : ""}{p.isSpectator ? " 👁" : ""}</span>
                {currentTurn === id && <span style={{ color: "#f0d090", marginLeft: "auto" }}>◀</span>}
              </div>
            ))}
          </div>

          <label style={lbl}>Environment</label>
          <select value={envType} onChange={(e) => onChangeEnv(e.target.value)} style={{ ...inp, cursor: "pointer", letterSpacing: 0 }}>
            {Object.entries(ENVS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>

          {!isSpectator && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8 }}>
              <button style={{ ...btn, background: "#7f1d1d", color: "#fca5a5" }} onClick={onRebuild}>↺ Rebuild Tower</button>
              <button style={{ ...btn, background: "#1e293b", color: "#94a3b8" }} onClick={onOpenSettings}>⚙ Room Settings</button>
            </div>
          )}

          <StatsPanel matchStats={matchStats} myId={myId} />
          <button style={{ ...btn, background: "#3f1010", color: "#fca5a5", marginTop: 8 }} onClick={onLeave}>Leave room</button>
        </div>
      )}

      <div style={hlp}>{inRoom ? "Share the code above with anyone worldwide to play together." : "Create a room to get a code, or enter a friend's code to join."}</div>
    </div>
  );
}

// ─── Title screen — Local vs Online ──────────────────────────────────────────────
function TitleScreen({ onLocal, onOnline }) {
  return (
    <div style={titleWrap}>
      <div style={titleCard}>
        <div style={{ fontSize: 46, fontWeight: 900, letterSpacing: "0.18em", color: "#f0d090" }}>JENGA</div>
        <div style={{ fontSize: 12, color: "#8a7a5a", margin: "4px 0 26px", letterSpacing: "0.08em" }}>REAL-PHYSICS TOWER · PLAY ANYWHERE</div>
        <button style={{ ...bigBtn, background: "#4ade80", color: "#04210f" }} onClick={onLocal}>
          🎮 Local<div style={bigSub}>One device · pass &amp; play</div>
        </button>
        <button style={{ ...bigBtn, background: "#1d4ed8", color: "#fff" }} onClick={onOnline}>
          🌍 Online<div style={{ ...bigSub, color: "#cdd9ff" }}>Browse rooms · play worldwide</div>
        </button>
      </div>
    </div>
  );
}

// ─── Local game setup (pass-and-play) ────────────────────────────────────────────
function LocalSetup({ onStart, onBack }) {
  const [names, setNames] = useState(["Player 1", "Player 2"]);
  const setName = (i, v) => setNames((n) => n.map((x, j) => (j === i ? v : x)));
  return (
    <div style={titleWrap}>
      <div style={{ ...titleCard, width: 320 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#f0d090", marginBottom: 2 }}>Local game</div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>Take turns on this one device.</div>
        {names.map((n, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: P_COLORS[i % P_COLORS.length], flexShrink: 0 }} />
            <input value={n} onChange={(e) => setName(i, e.target.value)} style={{ ...inp, flex: 1, letterSpacing: 0 }} />
            {names.length > 2 && <button style={{ ...btn, width: 34, background: "#3f1010", color: "#fca5a5", padding: 0 }} onClick={() => setNames((p) => p.filter((_, j) => j !== i))}>×</button>}
          </div>
        ))}
        {names.length < 4 && <button style={{ ...btn, background: "#1e293b", color: "#94a3b8", marginBottom: 8 }} onClick={() => setNames((p) => [...p, `Player ${p.length + 1}`])}>+ Add player</button>}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button style={btn} onClick={() => onStart(names.map((s) => s.trim() || "Player"))}>Start game</button>
          <button style={{ ...btn, background: "#333", color: "#aaa" }} onClick={onBack}>Back</button>
        </div>
      </div>
    </div>
  );
}

// ─── Online room browser ─────────────────────────────────────────────────────────
function useRoomList() {
  const [rooms, setRooms] = useState([]);
  useEffect(() => {
    const unsub = onValue(ref(db, "rooms"), (snap) => {
      const data = snap.val() || {};
      setRooms(
        Object.entries(data)
          .map(([code, r]) => ({
            code,
            name: r?.name || code,
            players: r?.players ? Object.values(r.players).filter(Boolean).length : 0,
            locked: !!r?.settings?.password,
            createdAt: r?.createdAt || 0,
          }))
          .filter((r) => r.players > 0)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 25),
      );
    });
    return () => unsub();
  }, []);
  return rooms;
}

function RoomBrowser({ onCreate, onJoin, onBack }) {
  const rooms = useRoomList();
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [joinPass, setJoinPass] = useState({});
  const [err, setErr] = useState("");

  const doJoin = async (code) => {
    const res = await onJoin(code, joinPass[code] || "", false);
    if (res?.error) setErr(`${code}: ${res.error}`);
  };

  return (
    <div style={titleWrap}>
      <div style={{ ...titleCard, width: 384, maxHeight: "88vh", overflowY: "auto", alignItems: "stretch", textAlign: "left" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#f0d090" }}>🌍 Online</div>
          <button style={{ ...btn, width: "auto", background: "#333", color: "#aaa", padding: "6px 12px" }} onClick={onBack}>← Back</button>
        </div>

        <div style={{ ...sec, marginBottom: 14 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your room" style={{ ...inp, letterSpacing: 0 }} />
          <input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Password (optional)" type="password" style={{ ...inp, letterSpacing: 0 }} />
          <button style={btn} onClick={() => onCreate(name.trim(), pass)}>+ Create room</button>
        </div>

        <div style={{ fontSize: 10, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Open tables ({rooms.length})</div>
        {err && <div style={{ color: "#f87171", fontSize: 11, marginBottom: 6 }}>{err}</div>}
        {rooms.length === 0 && <div style={{ fontSize: 12, color: "#444", fontStyle: "italic" }}>No open rooms yet — create one above.</div>}
        {rooms.map((r) => (
          <div key={r.code} style={roomRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "#eee", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.locked ? "🔒 " : ""}{r.name}</div>
              <div style={{ fontSize: 10, color: "#777" }}>{r.code} · {r.players} player{r.players !== 1 ? "s" : ""}</div>
            </div>
            {r.locked && <input onChange={(e) => setJoinPass((p) => ({ ...p, [r.code]: e.target.value }))} placeholder="pw" type="password" style={{ ...inp, width: 52, padding: "5px 6px", letterSpacing: 0 }} />}
            <button style={{ ...btn, width: "auto", padding: "6px 12px" }} onClick={() => doJoin(r.code)}>Join</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── App root ────────────────────────────────────────────────────────────────────
export default function App() {
  const [myId] = useState(() => Math.random().toString(36).slice(2, 10));

  const {
    roomCode, status, isHost, players, currentTurn, removedIds, lockedBlocks,
    chatMsgs, gameIteration, envType, roomSettings, matchStats, isSpectator, remoteRef,
    createRoom, joinRoom, leaveRoom, emitPulled, lockBlock, unlockBlock,
    sendChat, triggerRebuild, changeEnv, updateSettings, recordCollapse, pushBlockStates,
  } = useFirebaseRoom(myId);

  const levels  = roomSettings.levels ?? DEFAULT_LEVELS;
  const gravity = roomSettings.gravity ?? DEFAULT_GRAVITY;

  const [blocks, setBlocks]             = useState(() => buildBlocks(DEFAULT_LEVELS));
  const [settled, setSettled]           = useState(false);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [timeLeft, setTimeLeft]         = useState(TURN_SEC);
  const [analytics, setAnalytics]       = useState({ risk: 0, lean: 0, avgVel: 0, instability: 0 });
  const [draggingId, setDraggingId]     = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  // Collapsible side menus — auto-collapse on narrow/mobile screens
  const isMobile = useMemo(() => typeof window !== "undefined" && window.innerWidth < 720, []);
  const [panelOpen, setPanelOpen] = useState(!isMobile);
  const [hudOpen,   setHudOpen]   = useState(!isMobile);

  // Top-level view: title → choose Local (one device) or Online (room browser).
  const [view, setView]                 = useState("title"); // title | localSetup | local | online
  const [localPlayers, setLocalPlayers] = useState([]);      // pass-and-play names
  const [localTurn, setLocalTurn]       = useState(0);

  const rbRefs   = useRef(new Map());
  const shakeRef = useRef(() => {});
  const stabRef  = useRef(100);
  const prevRisk = useRef(0);
  const prevTurnRef = useRef(currentTurn);

  const { playTap, playPull, playCrash } = useAudio();
  const { stab, needsBtn, requestGyro }  = useGyro();
  stabRef.current = stab; // live mirror so the drag loop can read it without re-subscribing

  const thawDelays = useMemo(() => {
    const d = {};
    for (let lvl = 0; lvl < MAX_LEVELS; lvl++) d[lvl] = BASE_THAW + lvl * PER_LEVEL;
    return d;
  }, []);

  const playerColorMap = useMemo(() => {
    const m = {};
    Object.keys(players).forEach((id, i) => { m[id] = P_COLORS[i % P_COLORS.length]; });
    return m;
  }, [players]);

  const isLocal = view === "local";
  const inGame  = isLocal || (view === "online" && !!roomCode);

  // Local pass-and-play: it's always "your turn" (the device is shared); online:
  // my turn in the room (not spectating). Authority/active derive from these.
  const onlineMyTurn = (currentTurn === myId) && !isSpectator;
  const myTurn = isLocal ? true : onlineMyTurn;
  const active = inGame && myTurn && settled;
  const turnName = isLocal
    ? (localPlayers[localTurn] || "Player")
    : (players[currentTurn]?.name ?? currentTurn?.slice(0, 4) ?? "…");
  // Physics authority = whoever's turn it is. Local player is always authority;
  // online it's the turn-holder; spectators never are.
  const isAuthority = isLocal ? true : onlineMyTurn;

  const startSettle = useCallback((lv) => {
    setSettled(false);
    setTimeout(() => setSettled(true), settleMs(lv));
  }, []);

  useEffect(() => { startSettle(DEFAULT_LEVELS); }, [startSettle]);

  // Rebuild when iteration or level count changes
  useEffect(() => {
    setBlocks(buildBlocks(levels));
    setDraggingId(null);
    startSettle(levels);
  }, [gameIteration, levels, startSettle]);

  // Apply removed blocks from Firebase (online only — local manages its own)
  useEffect(() => {
    if (!roomCode) return;
    setBlocks((prev) => prev.map((b) => ({ ...b, removed: removedIds.includes(b.id) })));
  }, [removedIds, roomCode]);

  // Visual timer — resets when Firebase pushes a new turn
  useEffect(() => {
    if (prevTurnRef.current !== currentTurn) { prevTurnRef.current = currentTurn; setTimeLeft(TURN_SEC); }
  }, [currentTurn]);
  useEffect(() => {
    const t = setInterval(() => setTimeLeft((p) => (p <= 1 ? TURN_SEC : p - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  // Collapse → shake + crash sound + record
  useEffect(() => {
    const { risk, avgVel } = analytics;
    if (avgVel > 3 && risk > prevRisk.current) {
      shakeRef.current(Math.min(avgVel * 0.22, 1.0));
      if (avgVel > 8) { playCrash(); recordCollapse(blocks.filter((b) => !b.removed).length); }
    }
    prevRisk.current = risk;
  }, [analytics, playCrash, recordCollapse, blocks]);

  // ── Drag callbacks ──
  const onGrab = useCallback((blockId) => {
    setDraggingId(blockId);
    lockBlock(blockId);
    playTap();
  }, [lockBlock, playTap]);

  const onRelease = useCallback((blockId, wasPulled) => {
    setDraggingId(null);
    if (wasPulled) {
      setBlocks((p) => p.map((b) => b.id === blockId ? { ...b, removed: true } : b)); // optimistic
      playPull();
      if (isLocal) { setLocalTurn((t) => (localPlayers.length ? (t + 1) % localPlayers.length : 0)); setTimeLeft(TURN_SEC); }
      else if (roomCode) emitPulled(blockId);
      else setTimeLeft(TURN_SEC);
    } else if (!isLocal) {
      unlockBlock(blockId);
    }
  }, [isLocal, localPlayers.length, roomCode, emitPulled, unlockBlock, playPull]);

  // ── View / mode actions ──
  const startLocal = useCallback((names) => {
    setLocalPlayers(names); setLocalTurn(0); setView("local");
    setBlocks(buildBlocks(DEFAULT_LEVELS)); setDraggingId(null); startSettle(DEFAULT_LEVELS);
  }, [startSettle]);
  const exitToTitle = useCallback(() => {
    if (roomCode) leaveRoom();
    setView("title"); setLocalPlayers([]); setLocalTurn(0);
    setBlocks(buildBlocks(DEFAULT_LEVELS)); startSettle(DEFAULT_LEVELS);
  }, [roomCode, leaveRoom, startSettle]);

  // ── Lobby actions ──
  const onCreate = useCallback((name = "", password = "") => { createRoom(makeCode(), name, { password }); }, [createRoom]);
  const onJoinRoom = useCallback((code, pass, spectator) => joinRoom(code, pass, spectator), [joinRoom]);
  const onLeave = useCallback(() => { leaveRoom(); setBlocks(buildBlocks(DEFAULT_LEVELS)); startSettle(DEFAULT_LEVELS); setTimeLeft(TURN_SEC); }, [leaveRoom, startSettle]);

  return (
    <div style={root}>
      {/* In-room controls (online) */}
      {view === "online" && roomCode && (panelOpen ? (
        <Panel
          roomCode={roomCode} status={status} myId={myId} players={players} currentTurn={currentTurn}
          isSpectator={isSpectator} envType={envType} matchStats={matchStats} playerColorMap={playerColorMap}
          onCreate={onCreate} onJoin={onJoinRoom} onLeave={onLeave}
          onChangeEnv={changeEnv} onRebuild={triggerRebuild} onOpenSettings={() => setShowSettings(true)}
          onCollapse={() => setPanelOpen(false)}
        />
      ) : (
        <button style={{ ...reopenPill, top: 16, left: 16 }} onClick={() => setPanelOpen(true)}>☰ Room</button>
      ))}

      {/* Local pass-and-play controls */}
      {isLocal && (panelOpen ? (
        <div style={panel}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={ptitle}>JENGA</div>
            <button style={collapseBtn} onClick={() => setPanelOpen(false)} title="Collapse">‹</button>
          </div>
          <div style={psub}>Local · pass &amp; play</div>
          <div style={sec}>
            {localPlayers.map((n, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: P_COLORS[i % P_COLORS.length] }} />
                <span style={{ color: i === localTurn ? "#4ade80" : "#aaa", fontWeight: i === localTurn ? 800 : 500 }}>{n}</span>
                {i === localTurn && <span style={{ color: "#f0d090", marginLeft: "auto" }}>◀ turn</span>}
              </div>
            ))}
          </div>
          <button style={{ ...btn, background: "#7f1d1d", color: "#fca5a5", marginBottom: 7 }}
            onClick={() => { setBlocks(buildBlocks(DEFAULT_LEVELS)); setDraggingId(null); startSettle(DEFAULT_LEVELS); }}>↺ Rebuild Tower</button>
          <button style={{ ...btn, background: "#333", color: "#aaa" }} onClick={exitToTitle}>⏏ Exit to title</button>
        </div>
      ) : (
        <button style={{ ...reopenPill, top: 16, left: 16 }} onClick={() => setPanelOpen(true)}>☰ Menu</button>
      ))}

      <Canvas shadows camera={{ position: [7, 9.5, 9], fov: 44 }} style={{ position: "absolute", inset: 0, zIndex: 0 }} gl={{ antialias: true }}>
        <Scene
          blocks={blocks} rbRefs={rbRefs} thawDelays={thawDelays} settled={settled} gameIteration={gameIteration}
          gravity={gravity} levels={levels} envType={envType} active={active}
          lockedBlocks={lockedBlocks} playerColorMap={playerColorMap} myId={myId} draggingId={draggingId}
          onGrab={onGrab} onRelease={onRelease} onAnalyticsUpdate={setAnalytics}
          shakeRef={shakeRef} orbitEnabled={orbitEnabled} setOrbitEnabled={setOrbitEnabled} stabRef={stabRef}
          isAuthority={isAuthority} remoteRef={remoteRef} pushBlockStates={pushBlockStates}
        />
      </Canvas>

      {inGame && (hudOpen ? (
        <HUD analytics={analytics} stab={stab} needsBtn={needsBtn} requestGyro={requestGyro} myTurn={myTurn} timeLeft={timeLeft} settled={settled} turnName={turnName} onCollapse={() => setHudOpen(false)} />
      ) : (
        <button style={{ ...reopenPill, bottom: 16, right: 16 }} onClick={() => setHudOpen(true)}>📊 Stats</button>
      ))}

      {view === "online" && roomCode && <ChatWindow chatMsgs={chatMsgs} onSend={sendChat} myId={myId} playerColorMap={playerColorMap} />}

      {showSettings && <SettingsModal settings={roomSettings} onSave={updateSettings} onClose={() => setShowSettings(false)} isHost={isHost} />}

      {inGame && !settled && (
        <div style={ovl}>
          <div style={ovlBox}>
            <div style={ovlTitle}>Stacking blocks…</div>
            <div style={ovlTrack}><div style={{ ...ovlFill, animationDuration: `${settleMs(levels) / 1000}s` }} /></div>
            <div style={{ fontSize: 12, opacity: 0.4, marginTop: 8 }}>Physics settling</div>
          </div>
        </div>
      )}

      {/* ── Top-level views ── */}
      {view === "title" && <TitleScreen onLocal={() => setView("localSetup")} onOnline={() => setView("online")} />}
      {view === "localSetup" && <LocalSetup onStart={startLocal} onBack={() => setView("title")} />}
      {view === "online" && !roomCode && <RoomBrowser onCreate={onCreate} onJoin={onJoinRoom} onBack={exitToTitle} />}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const root  = { width: "100vw", height: "100vh", overflow: "hidden", background: "#0d0b08", color: "#fff", fontFamily: "'Inter', system-ui, sans-serif" };
const glass = { background: "rgba(10,8,5,0.86)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 10px 40px rgba(0,0,0,0.6)", color: "#fff", padding: 14 };

const panel  = { ...glass, position: "absolute", top: 16, left: 16, zIndex: 10, width: 250, maxHeight: "calc(100vh - 32px)", overflowY: "auto" };
const ptitle = { fontWeight: 900, fontSize: 22, letterSpacing: "0.12em", marginBottom: 2, color: "#f0d090" };
const psub   = { fontSize: 11, opacity: 0.45, marginBottom: 12, letterSpacing: "0.06em" };
const sec    = { display: "grid", gap: 8, marginBottom: 10, padding: 10, borderRadius: 12, background: "rgba(255,255,255,0.04)" };
const btn    = { width: "100%", border: 0, borderRadius: 9, padding: "9px 12px", background: "#4ade80", color: "#000", fontWeight: 800, fontSize: 12, cursor: "pointer" };
const inp    = { width: "100%", border: "1px solid rgba(255,255,255,0.11)", outline: "none", borderRadius: 8, padding: "8px 10px", fontWeight: 700, letterSpacing: "0.12em", background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: 13, boxSizing: "border-box" };
const sr     = { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 };
const dim    = { opacity: 0.5 };
const lbl    = { display: "block", fontSize: 10, color: "#666", marginBottom: 4, marginTop: 8, textTransform: "uppercase", letterSpacing: 0.8 };
const hlp    = { fontSize: 11, opacity: 0.4, lineHeight: 1.5, marginTop: 4 };
const collapseBtn = { border: 0, background: "rgba(255,255,255,0.08)", color: "#f0d090", width: 24, height: 24, borderRadius: 7, cursor: "pointer", fontSize: 15, fontWeight: 800, lineHeight: 1, flexShrink: 0 };
const reopenPill  = { position: "absolute", zIndex: 11, border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "9px 13px", background: "rgba(10,8,5,0.9)", backdropFilter: "blur(18px)", color: "#f0d090", fontWeight: 800, fontSize: 12, cursor: "pointer" };

const titleWrap = { position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(4,3,2,0.55)", backdropFilter: "blur(7px)" };
const titleCard = { ...glass, width: 300, padding: 28, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" };
const bigBtn    = { width: "100%", border: 0, borderRadius: 12, padding: "14px 16px", fontWeight: 900, fontSize: 17, cursor: "pointer", marginBottom: 12 };
const bigSub    = { fontSize: 11, fontWeight: 600, opacity: 0.85, marginTop: 3 };
const roomRow   = { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 9, background: "rgba(255,255,255,0.04)", marginBottom: 6 };

const hud    = { ...glass, position: "absolute", bottom: 16, right: 16, zIndex: 10, width: 220 };
const hint   = { fontSize: 11, opacity: 0.42, lineHeight: 1.5, marginTop: 10 };
const gyroBtn = { width: "100%", border: 0, borderRadius: 9, padding: "9px 0", background: "#1d4ed8", color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer", marginTop: 10 };
const chat   = { ...glass, position: "absolute", bottom: 16, left: 16, zIndex: 10, width: 250, height: 210, display: "flex", flexDirection: "column" };

const ovl      = { position: "absolute", inset: 0, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.65)", backdropFilter: "blur(5px)" };
const ovlBox   = { ...glass, textAlign: "center", width: 220 };
const ovlTitle = { fontWeight: 800, fontSize: 17, color: "#f0d090", marginBottom: 14 };
const ovlTrack = { height: 5, borderRadius: 4, background: "rgba(255,255,255,0.1)", overflow: "hidden" };
const ovlFill  = { height: "100%", borderRadius: 4, background: "#7a4010", animation: "grow linear forwards" };
