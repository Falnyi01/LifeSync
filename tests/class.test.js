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
  testDirectory = await mkdtemp(path.join(os.tmpdir(), "lifesync-class-tests-"));
  process.env.LIFESYNC_DATABASE_PATH = path.join(testDirectory, "test.db");
  process.env.SESSION_SECRET = "class-test-session-secret";

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

function send(pathname, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (cookie) {
    headers.Cookie = cookie;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function createLoggedInUser() {
  const email = `class-${randomUUID()}@example.com`;
  const password = "Password123";

  const registration = await send("/api/register", {
    method: "POST",
    body: { name: "Class Student", email, password }
  });
  assert.equal(registration.status, 201);

  const login = await send("/api/login", {
    method: "POST",
    body: { email, password }
  });
  assert.equal(login.status, 200);

  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";")[0];
}

const classDetails = {
  name: "Biology 101",
  meetingDays: ["Monday", "Wednesday"],
  startTime: "09:00",
  endTime: "10:15",
  location: "Science Hall 204"
};

async function createClass(cookie, details = classDetails) {
  const response = await send("/api/classes", {
    method: "POST",
    cookie,
    body: details
  });
  assert.equal(response.status, 201);
  return (await response.json()).class;
}

test("creates, updates, and deletes a class for the signed-in user", async () => {
  const cookie = await createLoggedInUser();
  const created = await createClass(cookie);

  assert.deepEqual(created, { id: created.id, ...classDetails });

  const updatedDetails = {
    name: "Biology 101 Lab",
    meetingDays: ["Tuesday", "Thursday"],
    startTime: "13:00",
    endTime: "14:30",
    location: "Science Hall 210"
  };
  const updateResponse = await send(`/api/classes/${created.id}`, {
    method: "PUT",
    cookie,
    body: updatedDetails
  });

  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.deepEqual(updated.class, { id: created.id, ...updatedDetails });

  const deleteResponse = await send(`/api/classes/${created.id}`, {
    method: "DELETE",
    cookie
  });
  assert.equal(deleteResponse.status, 200);
});

test("rejects unauthenticated and invalid class requests", async () => {
  const unauthenticated = await send("/api/classes", {
    method: "POST",
    body: classDetails
  });
  assert.equal(unauthenticated.status, 401);

  const cookie = await createLoggedInUser();
  const invalidDays = await send("/api/classes", {
    method: "POST",
    cookie,
    body: { ...classDetails, meetingDays: ["Funday"] }
  });
  assert.equal(invalidDays.status, 400);

  const invalidTimes = await send("/api/classes", {
    method: "POST",
    cookie,
    body: { ...classDetails, startTime: "15:00", endTime: "14:00" }
  });
  assert.equal(invalidTimes.status, 400);
});

test("prevents users from editing or deleting another user's class", async () => {
  const ownerCookie = await createLoggedInUser();
  const classRecord = await createClass(ownerCookie);

  const otherUserCookie = await createLoggedInUser();
  const updateResponse = await send(`/api/classes/${classRecord.id}`, {
    method: "PUT",
    cookie: otherUserCookie,
    body: { ...classDetails, name: "Changed by another user" }
  });
  assert.equal(updateResponse.status, 404);

  const deleteResponse = await send(`/api/classes/${classRecord.id}`, {
    method: "DELETE",
    cookie: otherUserCookie
  });
  assert.equal(deleteResponse.status, 404);
});
