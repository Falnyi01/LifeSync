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

  await new Promise((resolve, reject) => {
    database.run(
      `CREATE TABLE classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        meeting_days TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        location TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      (error) => error ? reject(error) : resolve()
    );
  });

  await initializeDatabase();
  const classColumns = await new Promise((resolve, reject) => {
    database.all("PRAGMA table_info(classes)", (error, columns) =>
      error ? reject(error) : resolve(columns)
    );
  });
  assert.ok(classColumns.some((column) => column.name === "semester_id"));
  const classForeignKeys = await new Promise((resolve, reject) => {
    database.all("PRAGMA foreign_key_list(classes)", (error, rows) =>
      error ? reject(error) : resolve(rows)
    );
  });
  assert.ok(classForeignKeys.some((key) => key.from === "semester_id" && key.on_delete === "SET NULL"));

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
  const sessionCookie = cookie.split(";")[0];

  const semesterResponse = await send("/api/semesters", {
    method: "POST",
    cookie: sessionCookie,
    body: {
      name: "Fall 2026",
      startDate: "2026-09-01",
      endDate: "2026-12-15"
    }
  });
  assert.equal(semesterResponse.status, 201);
  const { semester } = await semesterResponse.json();
  return { cookie: sessionCookie, semesterId: semester.id };
}

const classDetails = {
  name: "Biology 101",
  meetingDays: ["Monday", "Wednesday"],
  startTime: "09:00",
  endTime: "10:15",
  location: "Science Hall 204"
};

async function createClass(user, details = classDetails) {
  const response = await send("/api/classes", {
    method: "POST",
    cookie: user.cookie,
    body: { ...details, semesterId: user.semesterId }
  });
  assert.equal(response.status, 201);
  return (await response.json()).class;
}

test("creates, updates, and deletes a class for the signed-in user", async () => {
  const user = await createLoggedInUser();
  const created = await createClass(user);

  assert.deepEqual(created, {
    id: created.id,
    ...classDetails,
    semesterId: user.semesterId,
    semesterStartDate: "2026-09-01",
    semesterEndDate: "2026-12-15"
  });

  const updatedDetails = {
    name: "Biology 101 Lab",
    meetingDays: ["Tuesday", "Thursday"],
    startTime: "13:00",
    endTime: "14:30",
    location: "Science Hall 210"
  };
  const updateResponse = await send(`/api/classes/${created.id}`, {
    method: "PUT",
    cookie: user.cookie,
    body: { ...updatedDetails, semesterId: user.semesterId }
  });

  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.deepEqual(updated.class, {
    id: created.id,
    ...updatedDetails,
    semesterId: user.semesterId,
    semesterStartDate: "2026-09-01",
    semesterEndDate: "2026-12-15"
  });

  const deleteResponse = await send(`/api/classes/${created.id}`, {
    method: "DELETE",
    cookie: user.cookie
  });
  assert.equal(deleteResponse.status, 200);
});

test("rejects unauthenticated and invalid class requests", async () => {
  const unauthenticated = await send("/api/classes", {
    method: "POST",
    body: classDetails
  });
  assert.equal(unauthenticated.status, 401);

  const user = await createLoggedInUser();
  const invalidDays = await send("/api/classes", {
    method: "POST",
    cookie: user.cookie,
    body: { ...classDetails, semesterId: user.semesterId, meetingDays: ["Funday"] }
  });
  assert.equal(invalidDays.status, 400);

  const invalidTimes = await send("/api/classes", {
    method: "POST",
    cookie: user.cookie,
    body: { ...classDetails, semesterId: user.semesterId, startTime: "15:00", endTime: "14:00" }
  });
  assert.equal(invalidTimes.status, 400);
});

test("prevents users from editing or deleting another user's class", async () => {
  const owner = await createLoggedInUser();
  const classRecord = await createClass(owner);

  const otherUser = await createLoggedInUser();
  const updateResponse = await send(`/api/classes/${classRecord.id}`, {
    method: "PUT",
    cookie: otherUser.cookie,
    body: {
      ...classDetails,
      semesterId: otherUser.semesterId,
      name: "Changed by another user"
    }
  });
  assert.equal(updateResponse.status, 404);

  const deleteResponse = await send(`/api/classes/${classRecord.id}`, {
    method: "DELETE",
    cookie: otherUser.cookie
  });
  assert.equal(deleteResponse.status, 404);
});

test("lists only the signed-in user's classes with their semester dates", async () => {
  const owner = await createLoggedInUser();
  const created = await createClass(owner);
  const otherUser = await createLoggedInUser();
  await createClass(otherUser);

  const response = await send("/api/classes", { cookie: owner.cookie });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.classes, [created]);

  const unauthenticated = await send("/api/classes");
  assert.equal(unauthenticated.status, 401);
});

test("rejects class creation linked to another user's semester", async () => {
  const user = await createLoggedInUser();
  const otherUser = await createLoggedInUser();
  const response = await send("/api/classes", {
    method: "POST",
    cookie: user.cookie,
    body: { ...classDetails, semesterId: otherUser.semesterId }
  });

  assert.equal(response.status, 404);
});

test("keeps a class when its semester is deleted and clears the association", async () => {
  const user = await createLoggedInUser();
  const created = await createClass(user);
  const deleteResponse = await send(`/api/semesters/${user.semesterId}`, {
    method: "DELETE",
    cookie: user.cookie
  });
  assert.equal(deleteResponse.status, 200);

  const listResponse = await send("/api/classes", { cookie: user.cookie });
  assert.equal(listResponse.status, 200);
  const result = await listResponse.json();
  assert.deepEqual(result.classes, [{
    ...created,
    semesterId: null,
    semesterStartDate: null,
    semesterEndDate: null
  }]);
});
