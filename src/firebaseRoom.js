import { ref, set, update, onValue, get } from "firebase/database";
import { db } from "./firebase";

const roomPath = (code) => ref(db, `rooms/${code}`);

export async function createRoom(code, playerId, initialState = {}) {
  await set(roomPath(code), {
    hostId: playerId,
    players: 1,
    currentPlayer: 1,
    timeLeft: 30,
    removedBlocks: [],
    createdAt: Date.now(),
    ...initialState,
  });
}

export async function joinRoom(code) {
  const r = roomPath(code);
  const snap = await get(r);
  const data = snap.val() || {};
  const nextPlayers = Math.max(2, data.players ? data.players + 1 : 2);

  await update(r, {
    players: nextPlayers,
  });
}

export function listenRoom(code, callback) {
  return onValue(roomPath(code), (snap) => {
    callback(snap.val());
  });
}

export async function updateRoom(code, data) {
  return update(roomPath(code), data);
}

export function roomRef(code) {
  return roomPath(code);
}