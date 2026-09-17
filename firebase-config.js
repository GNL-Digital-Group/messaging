// firebase-config.js — connects the app to YOUR Firebase project.
//
// Where to find these values (see README, step 2):
//   Firebase console → your project → ⚙ Project settings → "Your apps" →
//   the web app → "SDK setup and configuration" → Config.
//
// Replace every PASTE_… value below. These values are safe to publish — Firebase
// designs them to live in web pages; what protects your data is firestore.rules.

export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};
