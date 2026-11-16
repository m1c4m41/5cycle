import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/db.sqlite");
const sql = process.argv[2] ?? "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
const rows = db.prepare(sql).all();
console.log(JSON.stringify(rows, (k, v) => (v === null ? null : v), 1).slice(0, 4000));
