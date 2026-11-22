const crypto = require("node:crypto");
const path = require("node:path");
const { promisify } = require("node:util");
const express = require("express");
const { database, initializeDatabase } = require("./database/database");

const app = express();
const scrypt = promisify(crypto.scrypt);

app.use(express.json({ limit: "10kb" }));

app.get("/", (request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/index.html", (request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/register.html", (request, response) => {
  response.sendFile(path.join(__dirname, "register.html"));
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

module.exports = { app, startServer };
