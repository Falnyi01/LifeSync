const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

let app;
let database;
let initializeDatabase;
let server;
let baseUrl;
let testDirectory;

const previousDatabasePath = process.env.LIFESYNC_DATABASE_PATH;
const previousSessionSecret = process.env.SESSION_SECRET;

before(async () => {
  testDirectory = await mkdtemp(path.join(os.tmpdir(), "lifesync-login-tests-"));
  process.env.LIFESYNC_DATABASE_PATH = path.join(testDirectory, "test.db");
  process.env.SESSION_SECRET = "login-test-session-secret";

  ({ app } = require("../server"));
  ({ database, initializeDatabase } = require("../database/database"));

  await initializeDatabase();

  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  if (database) {
    await new Promise((resolve, reject) => {
      database.close((error) => error ? reject(error) : resolve());
    });
  }

  if (previousDatabasePath === undefined) {
    delete process.env.LIFESYNC_DATABASE_PATH;
  } else {
    process.env.LIFESYNC_DATABASE_PATH = previousDatabasePath;
  }

  if (previousSessionSecret === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = previousSessionSecret;
  }

  if (testDirectory) {
    await rm(testDirectory, { recursive: true, force: true });
  }
});

function post(pathname, details) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(details)
  });
}

function findUser(email) {
  return new Promise((resolve, reject) => {
    database.get(
      "SELECT id, name FROM users WHERE email = ?",
      [email],
      (error, user) => error ? reject(error) : resolve(user)
    );
  });
}

function findSession() {
  return new Promise((resolve, reject) => {
    database.get(
      "SELECT sess FROM sessions LIMIT 1",
      (error, row) => error ? reject(error) : resolve(row)
    );
  });
}

test("logs in with a valid password and creates a SQLite session", async () => {
  const email = `login-${randomUUID()}@example.com`;
  const password = "Password123";

  const registration = await post("/api/register", {
    name: "Login Student",
    email,
    password
  });
  assert.equal(registration.status, 201);

  const user = await findUser(email);
  const response = await post("/api/login", {
    email: email.toUpperCase(),
    password
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: "Login successful.",
    name: "Login Student"
  });

  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);

  const sessionRow = await findSession();
  assert.ok(sessionRow);
  assert.equal(JSON.parse(sessionRow.sess).userId, user.id);

  const planner = await fetch(`${baseUrl}/`, {
    headers: { Cookie: cookie.split(";")[0] },
    redirect: "manual"
  });
  assert.equal(planner.status, 200);
  assert.match(await planner.text(), /Student Planner/);
});

test("redirects signed-out visitors from the planner to login", async () => {
  for (const route of ["/", "/index.html"]) {
    const response = await fetch(`${baseUrl}${route}`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/login.html");
  }
});

test("rejects incorrect passwords and unknown accounts with the same message", async () => {
  const email = `wrong-password-${randomUUID()}@example.com`;
  const registration = await post("/api/register", {
    name: "Login Student",
    email,
    password: "Password123"
  });
  assert.equal(registration.status, 201);

  const wrongPassword = await post("/api/login", {
    email,
    password: "WrongPass123"
  });
  const unknownAccount = await post("/api/login", {
    email: `unknown-${randomUUID()}@example.com`,
    password: "Password123"
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownAccount.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownAccount.json());
  assert.equal(wrongPassword.headers.get("set-cookie"), null);
});

test("rejects missing and malformed login details", async () => {
  const cases = [
    { email: "", password: "Password123" },
    { email: "not-an-email", password: "Password123" },
    { email: "student@example.com", password: "" }
  ];

  for (const details of cases) {
    assert.equal((await post("/api/login", details)).status, 400);
  }
});
