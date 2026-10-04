// minimal in-memory mongo stub implementing the operators the app uses.
const { ObjectId } = require("mongodb");

function idEq(a, b) { return String(a) === String(b); }
function matches(doc, filter) {
  for (const k of Object.keys(filter)) {
    const f = filter[k];
    if (f && typeof f === "object" && !Array.isArray(f) && !(f instanceof Date) && !ObjectId.isValid(String(f))) {
      if ("$gte" in f && !(doc[k] >= f.$gte)) return false;
      continue;
    }
    if (!idEq(doc[k], f)) return false;
  }
  return true;
}

class Cursor {
  constructor(docs) { this.docs = docs; }
  sort(spec) {
    const [k, dir] = Object.entries(spec)[0];
    this.docs = this.docs.slice().sort((a, b) =>
      dir === -1 ? (b[k] > a[k] ? 1 : -1) : (a[k] > b[k] ? 1 : -1));
    return this;
  }
  limit(n) { this.docs = this.docs.slice(0, n); return this; }
  async toArray() { return this.docs; }
}

class Collection {
  constructor() { this.docs = []; }
  async createIndex() { return "idx"; }
  find(filter = {}) { return new Cursor(this.docs.filter((d) => matches(d, filter))); }
  async findOne(filter = {}) { return this.docs.find((d) => matches(d, filter)) || null; }
  async insertOne(doc) {
    const d = { ...doc, _id: doc._id || new ObjectId() };
    this.docs.push(d);
    return { insertedId: d._id };
  }
  async updateOne(filter, update, opts = {}) {
    const d = this.docs.find((x) => matches(x, filter));
    if (!d) {
      if (opts.upsert) {
        const nd = { ...filter };
        applyUpdate(nd, update, true);
        nd._id = new ObjectId();
        this.docs.push(nd);
        return { matchedCount: 0, upsertedId: nd._id };
      }
      return { matchedCount: 0 };
    }
    applyUpdate(d, update, false);
    return { matchedCount: 1 };
  }
  async deleteOne(filter) {
    const i = this.docs.findIndex((d) => matches(d, filter));
    if (i >= 0) this.docs.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
}

function applyUpdate(doc, update, isInsert) {
  for (const op of Object.keys(update)) {
    const fields = update[op];
    if (op === "$set") Object.assign(doc, fields);
    else if (op === "$setOnInsert" && isInsert) {
      for (const k of Object.keys(fields)) if (!(k in doc)) doc[k] = fields[k];
    } else if (op === "$push") {
      for (const k of Object.keys(fields)) { (doc[k] = doc[k] || []).push(fields[k]); }
    } else if (op === "$pull") {
      for (const k of Object.keys(fields)) {
        const cond = fields[k];
        doc[k] = (doc[k] || []).filter((t) => t.id !== cond.id);
      }
    }
  }
}

const collections = {};
function getDb() {
  return {
    collection: (name) => (collections[name] = collections[name] || new Collection()),
  };
}
async function connect() { return getDb(); }

module.exports = { connect, getDb, _reset: () => { for (const k of Object.keys(collections)) delete collections[k]; } };
