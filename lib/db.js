const { MongoClient } = require("mongodb");
let client = null, db = null;

async function connect() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI missing");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(process.env.MONGO_DB || "play");
  const c = db.collection.bind(db);
  await c("users").createIndex({ googleId: 1 }, { unique: true });
  await c("users").createIndex({ email: 1 });
  await c("playlists").createIndex({ owner: 1 });
  await c("liked").createIndex({ owner: 1, trackId: 1 }, { unique: true });
  await c("liked").createIndex({ owner: 1, at: -1 });
  await c("play_history").createIndex({ owner: 1, at: -1 });
  await c("play_history").createIndex({ owner: 1, trackId: 1 });
  await c("user_preferences").createIndex({ owner: 1 }, { unique: true });
  return db;
}

function getDb() {
  if (!db) throw new Error("db not connected");
  return db;
}

module.exports = { connect, getDb };
