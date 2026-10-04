// google oauth (id token from GIS) -> jwt session. mongodb user store.
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const { getDb } = require("./db");

const google = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogle(credential) {
  const ticket = await google.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const p = ticket.getPayload();
  return { googleId: p.sub, email: p.email, name: p.name, pic: p.picture };
}

async function loginOrCreate(profile) {
  const db = getDb();
  const users = db.collection("users");
  const now = new Date();
  const existing = await users.findOne({ googleId: profile.googleId });
  if (existing) {
    await users.updateOne({ googleId: profile.googleId }, { $set: { lastSeen: now, pic: profile.pic } });
    return existing;
  }
  const doc = { ...profile, createdAt: now, lastSeen: now };
  const r = await users.insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

function sign(user) {
  return jwt.sign(
    { uid: String(user._id), email: user.email, name: user.name, pic: user.pic },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: "login required" });
  try {
    req.user = jwt.verify(t, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "bad token" });
  }
}

module.exports = { verifyGoogle, loginOrCreate, sign, authRequired };
