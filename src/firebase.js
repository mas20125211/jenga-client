import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBjcoNXuDz92QcT5-ZjNdqzVyWCCOcYk7I",
  authDomain: "jenga-multiplayer.firebaseapp.com",
  projectId: "jenga-multiplayer",
  storageBucket: "jenga-multiplayer.firebasestorage.app",
  messagingSenderId: "537207238014",
  appId: "1:537207238014:web:fb9afe48587c70561a972f",
  measurementId: "G-F2QLBL1RKY"
};

const app = initializeApp(firebaseConfig);

export const db = getDatabase(app);