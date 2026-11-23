const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();

const databasePath = process.env.LIFESYNC_DATABASE_PATH
  || path.join(__dirname, "lifesync.db");
const database = new sqlite3.Database(databasePath);

function createTasksTable(callback) {
  database.run(
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('task', 'assignment')),
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      task_date TEXT,
      due_date TEXT,
      due_time TEXT,
      reminder_days INTEGER NOT NULL DEFAULT 0 CHECK (reminder_days BETWEEN 0 AND 30),
      reminder_date TEXT,
      class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CHECK (
        (item_type = 'task' AND task_date IS NOT NULL AND due_date IS NULL AND due_time IS NULL)
        OR
        (item_type = 'assignment' AND task_date IS NULL AND due_date IS NOT NULL AND due_time IS NOT NULL)
      )
    )`,
    (error) => {
      if (error) {
        callback(error);
        return;
      }

      database.all("PRAGMA table_info(tasks)", (error, columns) => {
        if (error) {
          callback(error);
          return;
        }

        const ensureCompletedColumn = () => {
          if (columns.some((column) => column.name === "completed_at")) {
            callback(null);
            return;
          }

          database.run("ALTER TABLE tasks ADD COLUMN completed_at TEXT", callback);
        };

        if (columns.some((column) => column.name === "class_id")) {
          ensureCompletedColumn();
          return;
        }

        database.run(
          "ALTER TABLE tasks ADD COLUMN class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL",
          (error) => {
            if (error) {
              callback(error);
              return;
            }

            ensureCompletedColumn();
          }
        );
      });
    }
  );
}

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    database.serialize(() => {
      database.run("PRAGMA foreign_keys = ON", (error) => {
        if (error) {
          reject(error);
          return;
        }

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

            database.run(
              `CREATE TABLE IF NOT EXISTS semesters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
              )`,
              (error) => {
                if (error) {
                  reject(error);
                  return;
                }

                database.run(
                  `CREATE TABLE IF NOT EXISTS classes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    semester_id INTEGER,
                    name TEXT NOT NULL,
                    meeting_days TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    location TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE SET NULL
                  )`,
                  (error) => {
                    if (error) {
                      reject(error);
                      return;
                    }

                    database.all("PRAGMA table_info(classes)", (error, columns) => {
                      if (error) {
                        reject(error);
                        return;
                      }

                      if (columns.some((column) => column.name === "semester_id")) {
                        createTasksTable((error) => error ? reject(error) : resolve(database));
                        return;
                      }

                      database.run(
                        "ALTER TABLE classes ADD COLUMN semester_id INTEGER REFERENCES semesters(id) ON DELETE SET NULL",
                        (error) => {
                          if (error) {
                            reject(error);
                            return;
                          }

                          createTasksTable((error) => error ? reject(error) : resolve(database));
                        }
                      );
                    });
                  }
                );
              }
            );
          }
        );
      });
    });
  });
}

module.exports = {
  database,
  databasePath,
  initializeDatabase
};
