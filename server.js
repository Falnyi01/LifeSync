const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const { database, initializeDatabase } = require("./database/database");

const app = express();
const scrypt = promisify(crypto.scrypt);
const sessionStore = new SQLiteStore({
  db: database,
  table: "sessions"
});

function getSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  const secretPath = path.join(__dirname, "database", "session-secret");

  try {
    const savedSecret = fs.readFileSync(secretPath, "utf8").trim();
    if (savedSecret) {
      return savedSecret;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const newSecret = crypto.randomBytes(32).toString("hex");

  try {
    fs.writeFileSync(secretPath, newSecret, { encoding: "utf8", flag: "wx" });
    return newSecret;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }

    const savedSecret = fs.readFileSync(secretPath, "utf8").trim();
    if (!savedSecret) {
      throw new Error("The LifeSync session secret file is empty.");
    }
    return savedSecret;
  }
}

function verifyPassword(password, storedHash) {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(storedHash);
  if (!match) {
    return Promise.resolve(false);
  }

  const salt = Buffer.from(match[1], "hex");
  const expectedHash = Buffer.from(match[2], "hex");

  return scrypt(password, salt, expectedHash.length).then((actualHash) =>
    crypto.timingSafeEqual(actualHash, expectedHash)
  );
}

function regenerateSession(currentSession) {
  return new Promise((resolve, reject) => {
    currentSession.regenerate((error) => error ? reject(error) : resolve());
  });
}

function saveSession(currentSession) {
  return new Promise((resolve, reject) => {
    currentSession.save((error) => error ? reject(error) : resolve());
  });
}

app.use(express.json({ limit: "10kb" }));
app.use(session({
  store: sessionStore,
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

function requireLogin(request, response, next) {
  response.set("Cache-Control", "no-store");

  if (!request.session.userId) {
    return response.redirect("/login.html");
  }

  return next();
}

function requireApiLogin(request, response, next) {
  response.set("Cache-Control", "no-store");

  if (!request.session.userId) {
    return response.status(401).json({ message: "Log in to manage semesters." });
  }

  return next();
}

function isValidDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getSemesterDetails(body) {
  const details = body && typeof body === "object" ? body : {};
  const name = typeof details.name === "string" ? details.name.trim() : "";
  const startDate = typeof details.startDate === "string" ? details.startDate : "";
  const endDate = typeof details.endDate === "string" ? details.endDate : "";

  if (!name || name.length > 100) {
    return { error: "Enter a semester name of 1 to 100 characters." };
  }

  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    return { error: "Enter valid start and end dates." };
  }

  if (startDate > endDate) {
    return { error: "The end date must be on or after the start date." };
  }

  return { name, startDate, endDate };
}

function getSemesterId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

app.get("/", requireLogin, (request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/index.html", requireLogin, (request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/register.html", (request, response) => {
  response.sendFile(path.join(__dirname, "register.html"));
});

app.get("/login.html", (request, response) => {
  response.sendFile(path.join(__dirname, "login.html"));
});

app.get("/style.css", (request, response) => {
  response.sendFile(path.join(__dirname, "style.css"));
});

app.get("/script.js", (request, response) => {
  response.sendFile(path.join(__dirname, "script.js"));
});

app.get("/register.js", (request, response) => {
  response.sendFile(path.join(__dirname, "register.js"));
});

app.get("/login.js", (request, response) => {
  response.sendFile(path.join(__dirname, "login.js"));
});

app.post("/api/register", async (request, response) => {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name || name.length > 100) {
    return response.status(400).json({ message: "Enter a name of 1 to 100 characters." });
  }

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return response.status(400).json({ message: "Enter a valid email address." });
  }

  if (password.length < 8 || password.length > 128) {
    return response.status(400).json({ message: "Password must be 8 to 128 characters." });
  }

  try {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64);
    const passwordHash = `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;

    await new Promise((resolve, reject) => {
      database.run(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
        [name, email, passwordHash],
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    });

    return response.status(201).json({ message: "Account created successfully." });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT" && error.message.includes("users.email")) {
      return response.status(409).json({ message: "An account with that email already exists." });
    }

    console.error("Account registration failed:", error);
    return response.status(500).json({ message: "Unable to create your account right now." });
  }
});

app.post("/api/login", async (request, response) => {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const email = typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return response.status(400).json({ message: "Enter your email and password." });
  }

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length > 128
  ) {
    return response.status(400).json({ message: "Enter a valid email and password." });
  }

  try {
    const user = await new Promise((resolve, reject) => {
      database.get(
        "SELECT id, name, password_hash FROM users WHERE email = ?",
        [email],
        (error, row) => error ? reject(error) : resolve(row)
      );
    });

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return response.status(401).json({ message: "Email or password is incorrect." });
    }

    await regenerateSession(request.session);
    request.session.userId = user.id;
    await saveSession(request.session);

    return response.json({
      message: "Login successful.",
      name: user.name
    });
  } catch (error) {
    console.error("Account login failed:", error);
    return response.status(500).json({ message: "Unable to log in right now." });
  }
});

app.post("/api/logout", (request, response) => {
  request.session.destroy((error) => {
    if (error) {
      console.error("Session logout failed:", error);
      return response.status(500).json({ message: "Unable to log out right now." });
    }

    response.clearCookie("connect.sid");
    return response.json({ message: "Logout successful." });
  });
});

app.get("/api/semesters", requireApiLogin, async (request, response) => {
  try {
    const semesters = await new Promise((resolve, reject) => {
      database.all(
        `SELECT id, name, start_date AS startDate, end_date AS endDate
         FROM semesters
         WHERE user_id = ?
         ORDER BY start_date, id`,
        [request.session.userId],
        (error, rows) => error ? reject(error) : resolve(rows)
      );
    });

    return response.json({ semesters });
  } catch (error) {
    console.error("Semester list failed:", error);
    return response.status(500).json({ message: "Unable to load semesters right now." });
  }
});

app.post("/api/semesters", requireApiLogin, async (request, response) => {
  const details = getSemesterDetails(request.body);
  if (details.error) {
    return response.status(400).json({ message: details.error });
  }

  try {
    const id = await new Promise((resolve, reject) => {
      database.run(
        "INSERT INTO semesters (user_id, name, start_date, end_date) VALUES (?, ?, ?, ?)",
        [request.session.userId, details.name, details.startDate, details.endDate],
        function (error) {
          if (error) {
            reject(error);
            return;
          }

          resolve(this.lastID);
        }
      );
    });

    return response.status(201).json({
      message: "Semester created successfully.",
      semester: { id, name: details.name, startDate: details.startDate, endDate: details.endDate }
    });
  } catch (error) {
    console.error("Semester creation failed:", error);
    return response.status(500).json({ message: "Unable to save the semester right now." });
  }
});

app.put("/api/semesters/:id", requireApiLogin, async (request, response) => {
  const id = getSemesterId(request.params.id);
  if (!id) {
    return response.status(400).json({ message: "Enter a valid semester ID." });
  }

  const details = getSemesterDetails(request.body);
  if (details.error) {
    return response.status(400).json({ message: details.error });
  }

  try {
    const changes = await new Promise((resolve, reject) => {
      database.run(
        `UPDATE semesters
         SET name = ?, start_date = ?, end_date = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
        [details.name, details.startDate, details.endDate, id, request.session.userId],
        function (error) {
          if (error) {
            reject(error);
            return;
          }

          resolve(this.changes);
        }
      );
    });

    if (!changes) {
      return response.status(404).json({ message: "Semester not found." });
    }

    return response.json({
      message: "Semester updated successfully.",
      semester: { id, name: details.name, startDate: details.startDate, endDate: details.endDate }
    });
  } catch (error) {
    console.error("Semester update failed:", error);
    return response.status(500).json({ message: "Unable to update the semester right now." });
  }
});

app.delete("/api/semesters/:id", requireApiLogin, async (request, response) => {
  const id = getSemesterId(request.params.id);
  if (!id) {
    return response.status(400).json({ message: "Enter a valid semester ID." });
  }

  try {
    const changes = await new Promise((resolve, reject) => {
      database.run(
        "DELETE FROM semesters WHERE id = ? AND user_id = ?",
        [id, request.session.userId],
        function (error) {
          if (error) {
            reject(error);
            return;
          }

          resolve(this.changes);
        }
      );
    });

    if (!changes) {
      return response.status(404).json({ message: "Semester not found." });
    }

    return response.json({ message: "Semester deleted successfully." });
  } catch (error) {
    console.error("Semester deletion failed:", error);
    return response.status(500).json({ message: "Unable to delete the semester right now." });
  }
});

app.use((error, request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }

  if (error.type === "entity.parse.failed") {
    return response.status(400).json({ message: "Invalid request data." });
  }

  console.error("Request failed:", error);
  return response.status(500).json({ message: "An unexpected error occurred." });
});

async function startServer() {
  await initializeDatabase();
  const port = Number(process.env.PORT) || 3000;

  return app.listen(port, () => {
    console.log(`LifeSync is running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Could not start LifeSync:", error);
    database.close();
    process.exitCode = 1;
  });
}

module.exports = { app, startServer, sessionStore };
