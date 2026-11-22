const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();

const databasePath = process.env.LIFESYNC_DATABASE_PATH
  || path.join(__dirname, "lifesync.db");
const database = new sqlite3.Database(databasePath);

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    database.serialize(() => {
      database.run(
        `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(database);
        }
      );
    });
  });
}

module.exports = {
  database,
  databasePath,
  initializeDatabase
};
