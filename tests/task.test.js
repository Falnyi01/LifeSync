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
  testDirectory = await mkdtemp(path.join(os.tmpdir(), "lifesync-task-tests-"));
  process.env.LIFESYNC_DATABASE_PATH = path.join(testDirectory, "test.db");
  process.env.SESSION_SECRET = "task-test-session-secret";

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

function dateAfterDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function send(pathname, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function createLoggedInUser() {
  const email = `task-${randomUUID()}@example.com`;
  const password = "Password123";

  const registration = await send("/api/register", {
    method: "POST",
    body: { name: "Task Student", email, password }
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

const personalTask = {
  type: "task",
  title: "Read chapter 4",
  notes: "Focus on the review questions.",
  taskDate: dateAfterDays(2),
  dueDate: "",
  dueTime: "",
  reminderDays: 0
};

const assignment = {
  type: "assignment",
  title: "Research paper",
  notes: "Submit the final draft.",
  taskDate: "",
  dueDate: dateAfterDays(14),
  dueTime: "23:59",
  reminderDays: 3
};

test("creates, updates, and deletes a personal task with saved notes", async () => {
  const cookie = await createLoggedInUser();
  const createResponse = await send("/api/tasks", {
    method: "POST",
    cookie,
    body: personalTask
  });

  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).task;
  assert.equal(created.title, personalTask.title);
  assert.equal(created.notes, personalTask.notes);
  assert.equal(created.date, personalTask.taskDate);
  assert.equal(created.isAssignment, false);

  const updatedDetails = {
    ...personalTask,
    title: "Read chapter 5",
    notes: "Bring questions to class.",
    taskDate: dateAfterDays(4)
  };
  const updateResponse = await send(`/api/tasks/${created.id}`, {
    method: "PUT",
    cookie,
    body: updatedDetails
  });

  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).task;
  assert.equal(updated.title, updatedDetails.title);
  assert.equal(updated.notes, updatedDetails.notes);
  assert.equal(updated.date, updatedDetails.taskDate);

  const listResponse = await send("/api/tasks", { cookie });
  assert.equal(listResponse.status, 200);
  const listResult = await listResponse.json();
  assert.deepEqual(listResult.tasks, [updated]);

  const deleteResponse = await send(`/api/tasks/${created.id}`, {
    method: "DELETE",
    cookie
  });
  assert.equal(deleteResponse.status, 200);
  const emptyListResponse = await send("/api/tasks", { cookie });
  assert.deepEqual((await emptyListResponse.json()).tasks, []);
});

test("stores assignment due dates and reminder dates", async () => {
  const cookie = await createLoggedInUser();
  const response = await send("/api/tasks", {
    method: "POST",
    cookie,
    body: assignment
  });

  assert.equal(response.status, 201);
  const { task } = await response.json();
  const expectedReminderDate = new Date(`${assignment.dueDate}T00:00:00.000Z`);
  expectedReminderDate.setUTCDate(expectedReminderDate.getUTCDate() - assignment.reminderDays);

  assert.equal(task.isAssignment, true);
  assert.equal(task.dueDate, assignment.dueDate);
  assert.equal(task.dueTime, assignment.dueTime);
  assert.equal(task.reminderDays, assignment.reminderDays);
  assert.equal(task.date, expectedReminderDate.toISOString().slice(0, 10));
});

test("validates task input and requires authentication", async () => {
  const unauthenticated = await send("/api/tasks", {
    method: "POST",
    body: personalTask
  });
  assert.equal(unauthenticated.status, 401);

  const cookie = await createLoggedInUser();
  const invalidDate = await send("/api/tasks", {
    method: "POST",
    cookie,
    body: { ...personalTask, taskDate: "2026-02-30" }
  });
  assert.equal(invalidDate.status, 400);

  const invalidReminder = await send("/api/tasks", {
    method: "POST",
    cookie,
    body: { ...assignment, reminderDays: 31 }
  });
  assert.equal(invalidReminder.status, 400);
});

test("keeps task lists and mutations scoped to the signed-in user", async () => {
  const ownerCookie = await createLoggedInUser();
  const createResponse = await send("/api/tasks", {
    method: "POST",
    cookie: ownerCookie,
    body: personalTask
  });
  assert.equal(createResponse.status, 201);
  const { task } = await createResponse.json();

  const otherUserCookie = await createLoggedInUser();
  const listResponse = await send("/api/tasks", { cookie: otherUserCookie });
  assert.deepEqual((await listResponse.json()).tasks, []);

  const updateResponse = await send(`/api/tasks/${task.id}`, {
    method: "PUT",
    cookie: otherUserCookie,
    body: personalTask
  });
  assert.equal(updateResponse.status, 404);

  const deleteResponse = await send(`/api/tasks/${task.id}`, {
    method: "DELETE",
    cookie: otherUserCookie
  });
  assert.equal(deleteResponse.status, 404);
});
