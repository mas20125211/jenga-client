# 🪵 Jenga Multiplayer

A real-time multiplayer 3D Jenga game built with React, Three.js physics, and Firebase — playable from any browser, anywhere in the world.

&nbsp;

## ✨ Features

- **Full 3D physics tower** — 54 wooden blocks with real friction, mass, and gravity
- **Click-and-drag pulling** — drag blocks in any direction; friction from neighbours resists you
- **Realistic physics** — zero bounce, heavy damping, staggered thaw so the tower settles naturally on load
- **Live multiplayer** — room codes sync turn state, block removal, and player list in real time via Firebase
- **Phone gyroscope** — shake detection measures hand stability while you pull
- **Turn timer** — 30 seconds per turn; server-authoritative via Firebase
- **Worldwide play** — Firebase handles the backend, no server to host
- **Deployable** — builds to a static site; works on Cloudflare Pages, Vercel, or Netlify for free

&nbsp;

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + Vite |
| 3D rendering | Three.js via `@react-three/fiber` |
| Physics | Rapier via `@react-three/rapier` |
| Helpers | `@react-three/drei` (OrbitControls, Text) |
| Multiplayer | Firebase Realtime Database |
| Device | Raspberry Pi 5 (also runs on any machine) |

&nbsp;

## 📁 Project Structure

```
jenga-client/
│
├── src/
│   ├── App.jsx          ← entire game: physics, drag, Firebase, UI
│   ├── firebase.js      ← Firebase app init + database export
│   ├── main.jsx         ← React root mount
│   └── index.css        ← resets + @keyframes grow (settle bar)
│
├── .env                 ← (optional) environment variables
├── package.json
└── vite.config.js
```

&nbsp;

## 🚀 Getting Started

### Prerequisites

- Node.js 18 or newer
- A Firebase project (free tier is fine — instructions below)
- A Raspberry Pi 5, laptop, or any machine that can run Node

---

### Step 1 — Clone or download

If you have git:
```bash
git clone https://github.com/YOUR_USERNAME/jenga-client.git
cd jenga-client
```

Or just copy the files manually onto your Pi into `~/jenga-client/`.

---

### Step 2 — Install dependencies

```bash
cd ~/jenga-client
npm install
```

This installs everything listed in `package.json`. If any package is missing, install it individually:

```bash
npm install firebase three @react-three/fiber @react-three/drei @react-three/rapier
```

---

### Step 3 — Set up Firebase

This is the most important step. Without it multiplayer will silently fail.

#### 3a. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → give it a name → click through the steps
3. On the left sidebar, click **Build → Realtime Database**
4. Click **Create Database** → choose a region → start in **test mode** (you'll lock it down later)

#### 3b. Get your config

1. In Firebase Console, click the gear icon → **Project settings**
2. Scroll down to **Your apps** → click the `</>` web icon to register a web app
3. Copy the `firebaseConfig` object — it looks like this:

```js
const firebaseConfig = {
  apiKey:            "AIzaSy...",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123...",
  databaseURL:       "https://your-project-default-rtdb.firebaseio.com"
};
```

#### 3c. Paste it into firebase.js

Open `src/firebase.js` and replace the config with yours:

```js
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  // paste your config here
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
```

#### 3d. Set database rules

> ⚠️ This is the step most people miss. Without it, all Firebase reads and writes are silently rejected and room codes will appear to connect but never sync.

1. In Firebase Console → **Realtime Database** → **Rules** tab
2. Replace the contents with:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

3. Click **Publish**

> These are open rules — fine for a game. If you want to lock it down later, read the [Firebase security rules docs](https://firebase.google.com/docs/database/security).

---

### Step 4 — Run the game

```bash
cd ~/jenga-client
npm run dev
```

You should see:

```
  VITE v5.x  ready in 800ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.xx:5173/
```

Open `http://localhost:5173` in your browser. The tower will stack itself over about 2 seconds and then you can play.

To test multiplayer locally, open a second tab to the same URL.

---

### Step 5 — Play on your phone (same Wi-Fi)

Find your Pi's local IP:

```bash
hostname -I
# e.g. 192.168.1.42
```

On your phone, open:
```
http://192.168.1.42:5173
```

The gyroscope will activate automatically on Android. On iOS you'll see an **Enable gyro** button — tap it and allow motion access.

&nbsp;

## 🎮 How to Play

| Action | How |
|---|---|
| Rotate camera | Click and drag (or one-finger drag on touch) |
| Select a block | Click / tap it |
| Pull a block | Click and drag it sideways — it slides with real friction |
| End your turn | Pull a block far enough (62% of its length) — turn advances automatically |
| Invite someone | Share the 4-letter room code shown in the top-left panel |

**The stability meter** in the bottom-right drops when you move your phone. On a real table with friends, try to keep steady hands while you pull — shaky hands show on screen.

&nbsp;

## 🌍 Deploying for Worldwide Play

Firebase is already worldwide — you just need to host the frontend.

### Option A — Cloudflare Pages (recommended, free)

```bash
cd ~/jenga-client
npm run build
```

Then go to [pages.cloudflare.com](https://pages.cloudflare.com), create a project, and upload the `dist/` folder. Done. Your game gets a `*.pages.dev` URL instantly.

### Option B — Vercel (free)

```bash
npm install -g vercel
cd ~/jenga-client
vercel
```

Follow the prompts. Vercel auto-detects Vite and deploys in under a minute.

### Option C — Netlify (free)

```bash
npm run build
```

Drag the `dist/` folder onto [app.netlify.com](https://app.netlify.com/drop). You get a live URL immediately with no account needed.

---

Once deployed, share your URL with anyone. They open it in a browser, enter your room code, and they're in the same game — no install required.

&nbsp;

## 🗄 Firebase Data Schema

Understanding this helps if you want to extend the game.

```
rooms/
  {roomCode}/               ← e.g. "AB3K"
    current:   "a1b2c3d4"   ← player ID whose turn it is
    createdAt: 1718000000000
    players/
      a1b2c3d4: 1718000001  ← player ID → timestamp they joined
      e5f6g7h8: 1718000045  ← second player
    removed/
      b3-1: true            ← block "level 3, column 1" has been pulled
      b7-0: true
```

Turn order is determined by join timestamp — earliest joiner goes first.

When a block is pulled, two writes happen atomically:
- `removed/{blockId}` is set to `true`
- `current` is updated to the next player's ID

All connected clients get both changes instantly via `onValue()`.

&nbsp;

## 🔧 Physics Tuning

All physics constants are at the top of `App.jsx` and are easy to tweak:

```js
const GRAVITY     = -11;   // increase for heavier feel (default Earth = -9.81)
const FRICTION    = 0.90;  // 0–1, higher = more grip between blocks
const RESTITUTION = 0.0;   // bounciness — 0 = no bounce (wood-like)
const LIN_DAMP    = 5.5;   // how fast blocks stop moving linearly
const ANG_DAMP    = 6.0;   // how fast blocks stop rotating
const MASS        = 1.8;   // block mass in kg (affects how hard they are to push)
```

The tower uses **staggered thaw** — each level of blocks unfreezes 80ms after the one below it, so the tower settles naturally from the bottom up instead of all 54 blocks activating at once (which causes them to explode outward).


**`npm run dev` fails**
```bash
rm -rf node_modules package-lock.json
npm install
npm run dev
```

&nbsp;

## 📜 License

MIT — do whatever you want with it.

&nbsp;

---

Built on a Raspberry Pi 5. Physics by [Rapier](https://rapier.rs). Rendering by [Three.js](https://threejs.org). Multiplayer by [Firebase](https://firebase.google.com).
