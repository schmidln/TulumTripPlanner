import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyC5afJ4T-fcu8n9DpMAUZLpI9YnXq9di30",
  authDomain: "tulumtripplanner.firebaseapp.com",
  projectId: "tulumtripplanner",
  storageBucket: "tulumtripplanner.firebasestorage.app",
  messagingSenderId: "242630055169",
  appId: "1:242630055169:web:9e0f5d0ecda280c5297700",
  measurementId: "G-QEJP17JRRF"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
