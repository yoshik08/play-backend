#!/usr/bin/env node
/**
 * scripts/mint-drive-token.js
 *
 * ONE-TIME setup: mints a Google Drive refresh token for Yoshik's account.
 * The backend uses this token (via DRIVE_REFRESH_TOKEN env) to store all
 * uploads in Yoshik's Drive folder "yoshik-play". End users never do Drive OAuth.
 *
 * Usage:
 *   1. Fill GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (or export them).
 *   2. Run: node scripts/mint-drive-token.js
 *   3. Visit the printed URL, sign in as Yoshik, approve Drive file access.
 *   4. You'll land on https://yoshik.xyz/play?code=XXX — copy the code.
 *   5. Paste the code when prompted. The script prints the refresh token.
 *   6. Paste the refresh token into Render dashboard > play-api > Environment
 *      as DRIVE_REFRESH_TOKEN, then redeploy (or it picks up on restart).
 *
 * The token has drive.file scope: it can only touch files the app created.
 */
const readline = require("readline");
const path = require("path");
const fs = require("fs");

// load .env if present (no dependency)
(function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
})();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "https://yoshik.xyz/play";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth" +
  "?client_id=" + encodeURIComponent(CLIENT_ID) +
  "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
  "&response_type=code" +
  "&scope=" + encodeURIComponent(SCOPE) +
  "&access_type=offline" +
  "&prompt=consent";

console.log("\n1) Visit this URL in your browser (signed in as Yoshik):\n");
console.log(authUrl);
console.log("\n2) Approve Drive file access. You'll land on");
console.log("   https://yoshik.xyz/play?code=XXX");
console.log("3) Copy the code from the address bar and paste it below.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("paste code: ", async (code) => {
  rl.close();
  code = (code || "").trim();
  if (!code) {
    console.error("no code given");
    process.exit(1);
  }
  try {
    const params = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const d = await r.json();
    if (!r.ok) {
      console.error("token exchange failed:", d.error, "-", d.error_description);
      process.exit(1);
    }
    if (!d.refresh_token) {
      console.error("Google did not return a refresh token. Make sure you used a fresh consent (prompt=consent) and approved as Yoshik.");
      process.exit(1);
    }
    console.log("\nSUCCESS. Add this to Render > play-api > Environment:\n");
    console.log("DRIVE_REFRESH_TOKEN=" + d.refresh_token);
    console.log("\nThen redeploy (or restart) the service. Verify with:");
    console.log("  curl https://play-api-n8hk.onrender.com/health");
    console.log('  (look for "drive": {"ok": true})');
  } catch (e) {
    console.error("failed:", e.message);
    process.exit(1);
  }
});
