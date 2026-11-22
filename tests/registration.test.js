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
  testDirectory = await mkdtemp(path.join(os.tmpdir(), "lifesync-tests-"));
  process.env.LIFESYNC_DATABASE_PATH = path.join(testDirectory, "test.db");
  process.env.SESSION_SECRET = "registration-test-session-secret";

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

function register(details) {
  return fetch(`${baseUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(details)
  });
}

function findUser(email) {
  return new Promise((resolve, reject) => {
    database.get(
      "SELECT name, email, password_hash FROM users WHERE email = ?",
      [email],
      (error, user) => error ? reject(error) : resolve(user)
    );
  });
}

function countUsers(email) {
  return new Promise((resolve, reject) => {
    database.get(
      "SELECT COUNT(*) AS count FROM users WHERE email = ?",
      [email],
      (error, result) => error ? reject(error) : resolve(result.count)
    );
  });
}

test("creates an account and stores only a password hash", async () => {
  const email = `student-${randomUUID()}@example.com`;
  const password = "Password123";

  const response = await register({
    name: "Test Student",
    email: email.toUpperCase(),
    password
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    message: "Account created successfully."
  });

  const user = await findUser(email);
  assert.equal(user.name, "Test Student");
  assert.equal(user.email, email);
  assert.match(user.password_hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.notEqual(user.password_hash, password);
});

test("rejects duplicate emails regardless of capitalization", async () => {
  const email = `duplicate-${randomUUID()}@example.com`;
  const details = { name: "Test Student", email, password: "Password123" };

  assert.equal((await register(details)).status, 201);
  assert.equal((await register(details)).status, 409);
  assert.equal((await register({
    ...details,
    email: email.toUpperCase()
  })).status, 409);
  assert.equal(await countUsers(email), 1);
});

test("rejects missing or invalid fields and invalid password lengths", async () => {
  const email = `invalid-${randomUUID()}@example.com`;
  const cases = [
    { name: "", email, password: "Password123" },
    { name: "Test Student", email: "", password: "Password123" },
    { name: "Test Student", email: "not-an-email", password: "Password123" },
    { name: "Test Student", email, password: "" },
    { name: "Test Student", email, password: "short" },
    { name: "Test Student", email, password: "x".repeat(129) }
  ];

  for (const details of cases) {
    assert.equal((await register(details)).status, 400);
  }
});
