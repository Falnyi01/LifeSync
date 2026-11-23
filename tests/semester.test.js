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
  testDirectory = await mkdtemp(path.join(os.tmpdir(), "lifesync-semester-tests-"));
  process.env.LIFESYNC_DATABASE_PATH = path.join(testDirectory, "test.db");
  process.env.SESSION_SECRET = "semester-test-session-secret";

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
  const email = `semester-${randomUUID()}@example.com`;
  const password = "Password123";

  const registration = await send("/api/register", {
    method: "POST",
    body: { name: "Semester Student", email, password }
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

const semesterDetails = {
  name: "Fall 2026",
  startDate: "2026-08-24",
  endDate: "2026-12-18"
};

test("creates, updates, and deletes a semester for the signed-in user", async () => {
  const cookie = await createLoggedInUser();
  const createResponse = await send("/api/semesters", {
    method: "POST",
    cookie,
    body: semesterDetails
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.deepEqual(created.semester, {
    id: created.semester.id,
    ...semesterDetails
  });

  const updatedDetails = {
    name: "Fall 2026 Updated",
    startDate: "2026-08-25",
    endDate: "2026-12-19"
  };
  const updateResponse = await send(`/api/semesters/${created.semester.id}`, {
    method: "PUT",
    cookie,
    body: updatedDetails
  });

  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.deepEqual(updated.semester, {
    id: created.semester.id,
    ...updatedDetails
  });

  const deleteResponse = await send(`/api/semesters/${created.semester.id}`, {
    method: "DELETE",
    cookie
  });
  assert.equal(deleteResponse.status, 200);
});

test("rejects unauthenticated and invalid semester requests", async () => {
  const unauthenticated = await send("/api/semesters", {
    method: "POST",
    body: semesterDetails
  });
  assert.equal(unauthenticated.status, 401);

  const cookie = await createLoggedInUser();
  const invalidDate = await send("/api/semesters", {
    method: "POST",
    cookie,
    body: { ...semesterDetails, startDate: "2026-02-30" }
  });
  assert.equal(invalidDate.status, 400);

  const reversedDates = await send("/api/semesters", {
    method: "POST",
    cookie,
    body: { ...semesterDetails, startDate: "2026-12-19" }
  });
  assert.equal(reversedDates.status, 400);
});

test("prevents users from editing or deleting another user's semester", async () => {
  const ownerCookie = await createLoggedInUser();
  const createResponse = await send("/api/semesters", {
    method: "POST",
    cookie: ownerCookie,
    body: semesterDetails
  });
  assert.equal(createResponse.status, 201);
  const { semester } = await createResponse.json();

  const otherUserCookie = await createLoggedInUser();
  const updateResponse = await send(`/api/semesters/${semester.id}`, {
    method: "PUT",
    cookie: otherUserCookie,
    body: { ...semesterDetails, name: "Changed by another user" }
  });
  assert.equal(updateResponse.status, 404);

  const deleteResponse = await send(`/api/semesters/${semester.id}`, {
    method: "DELETE",
    cookie: otherUserCookie
  });
  assert.equal(deleteResponse.status, 404);
});
