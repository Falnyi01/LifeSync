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
    return response.status(401).json({ message: "Log in to manage your planner." });
  }

  return next();
}

const classMeetingDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function getClassDetails(body) {
  const details = body && typeof body === "object" ? body : {};
  const name = typeof details.name === "string" ? details.name.trim() : "";
  const location = typeof details.location === "string" ? details.location.trim() : "";
  const meetingDays = Array.isArray(details.meetingDays) ? details.meetingDays : [];
  const semesterId = getPositiveId(details.semesterId);
  const startTime = typeof details.startTime === "string" ? details.startTime : "";
  const endTime = typeof details.endTime === "string" ? details.endTime : "";

  if (!name || name.length > 100) {
    return { error: "Enter a class name of 1 to 100 characters." };
  }

  if (meetingDays.length === 0 || meetingDays.some((day) => !classMeetingDays.includes(day))) {
    return { error: "Select at least one valid meeting day." };
  }

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
    return { error: "Enter valid start and end times." };
  }

  if (startTime >= endTime) {
    return { error: "End time must be later than start time." };
  }

  if (!location || location.length > 200) {
    return { error: "Enter a location of 1 to 200 characters." };
  }

  if (!semesterId) {
    return { error: "Select a semester for this class." };
  }

  return {
    name,
    meetingDays: classMeetingDays.filter((day) => meetingDays.includes(day)),
    semesterId,
    startTime,
    endTime,
    location
  };
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

function getPositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getTaskDetails(body) {
  const details = body && typeof body === "object" ? body : {};
  const itemType = details.type;
  const title = typeof details.title === "string" ? details.title.trim() : "";
  const notes = typeof details.notes === "string" ? details.notes.trim() : "";
  const taskDate = typeof details.taskDate === "string" ? details.taskDate : "";
  const dueDate = typeof details.dueDate === "string" ? details.dueDate : "";
  const dueTime = typeof details.dueTime === "string" ? details.dueTime : "";
  const reminderDays = details.reminderDays === undefined ? 0 : Number(details.reminderDays);
  const hasClassId = details.classId !== undefined && details.classId !== null && details.classId !== "";
  const classId = hasClassId ? getPositiveId(details.classId) : null;

  if (itemType !== "task" && itemType !== "assignment") {
    return { error: "Choose a personal task or assignment." };
  }
  if (hasClassId && !classId) {
    return { error: "Choose a valid saved class." };
  }
  if (itemType === "task" && classId !== null) {
    return { error: "Only assignments can be linked to a class." };
  }
  if (!title || title.length > 100) {
    return { error: "Enter a title of 1 to 100 characters." };
  }
  if (typeof details.notes !== "undefined" && typeof details.notes !== "string") {
    return { error: "Notes must be text." };
  }
  if (notes.length > 500) {
    return { error: "Notes must be 500 characters or fewer." };
  }
  if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 30) {
    return { error: "Reminder days must be a whole number from 0 to 30." };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (itemType === "task") {
    if (!isValidDateString(taskDate)) {
      return { error: "Enter a valid task date." };
    }
    if (taskDate < today) {
      return { error: "The selected date must be today or later." };
    }

    const maximumDate = new Date(`${today}T00:00:00.000Z`);
    maximumDate.setUTCDate(maximumDate.getUTCDate() + 7);
    if (taskDate > maximumDate.toISOString().slice(0, 10)) {
      return { error: "Tasks can only be created for today or up to 7 days in the future." };
    }

    return {
      itemType,
      title,
      notes,
      taskDate,
      dueDate: null,
      dueTime: null,
      reminderDays: 0,
      reminderDate: null,
      classId: null
    };
  }

  if (!isValidDateString(dueDate) || dueDate < today) {
    return { error: "Enter a valid assignment due date that is today or later." };
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) {
    return { error: "Enter a valid assignment due time." };
  }

  const reminderDate = new Date(`${dueDate}T00:00:00.000Z`);
  reminderDate.setUTCDate(reminderDate.getUTCDate() - reminderDays);

  return {
    itemType,
    title,
    notes,
    taskDate: null,
    dueDate,
    dueTime,
    reminderDays,
    reminderDate: reminderDate.toISOString().slice(0, 10),
    classId
  };
}

function toTodoItem(task) {
  const isAssignment = task.itemType === "assignment";

  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    date: isAssignment ? task.reminderDate || task.dueDate : task.taskDate,
    originalDate: null,
    createdDate: isAssignment ? task.dueDate : task.taskDate,
    isAssignment,
    dueDate: isAssignment ? task.dueDate : "",
    dueTime: isAssignment ? task.dueTime : "",
    reminderDays: isAssignment ? task.reminderDays : 0,
    reminderDate: isAssignment ? task.reminderDate : null,
    classId: isAssignment ? task.classId : null,
    className: isAssignment ? task.className || "" : ""
  };
}

function findSemesterForUser(userId, semesterId) {
  return new Promise((resolve, reject) => {
    database.get(
      `SELECT id, start_date AS startDate, end_date AS endDate
       FROM semesters
       WHERE id = ? AND user_id = ?`,
      [semesterId, userId],
      (error, semester) => error ? reject(error) : resolve(semester)
    );
  });
}

function findClassForUser(userId, classId) {
  return new Promise((resolve, reject) => {
    database.get(
      "SELECT id, name FROM classes WHERE id = ? AND user_id = ?",
      [classId, userId],
      (error, classRecord) => error ? reject(error) : resolve(classRecord || null)
    );
  });
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
  const id = getPositiveId(request.params.id);
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
  const id = getPositiveId(request.params.id);
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

app.get("/api/tasks", requireApiLogin, async (request, response) => {
  try {
    const tasks = await new Promise((resolve, reject) => {
      database.all(
        `SELECT t.id, t.item_type AS itemType, t.title, t.notes,
                t.task_date AS taskDate, t.due_date AS dueDate,
                t.due_time AS dueTime, t.reminder_days AS reminderDays,
                t.reminder_date AS reminderDate, t.class_id AS classId,
                c.name AS className
         FROM tasks t
         LEFT JOIN classes c ON c.id = t.class_id AND c.user_id = t.user_id
         WHERE t.user_id = ?
         ORDER BY COALESCE(t.task_date, t.reminder_date), t.id`,
        [request.session.userId],
        (error, rows) => error ? reject(error) : resolve(rows)
      );
    });

    return response.json({
      userId: request.session.userId,
      tasks: tasks.map(toTodoItem)
    });
  } catch (error) {
    console.error("Task list failed:", error);
    return response.status(500).json({ message: "Unable to load tasks right now." });
  }
});

app.post("/api/tasks", requireApiLogin, async (request, response) => {
  const details = getTaskDetails(request.body);
  if (details.error) {
    return response.status(400).json({ message: details.error });
  }

  try {
    const classRecord = details.classId === null
      ? null
      : await findClassForUser(request.session.userId, details.classId);
    if (details.classId !== null && !classRecord) {
      return response.status(404).json({ message: "Class not found." });
    }

    const id = await new Promise((resolve, reject) => {
      database.run(
        `INSERT INTO tasks (
          user_id, item_type, title, notes, task_date, due_date,
          due_time, reminder_days, reminder_date, class_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          request.session.userId,
          details.itemType,
          details.title,
          details.notes,
          details.taskDate,
          details.dueDate,
          details.dueTime,
          details.reminderDays,
          details.reminderDate,
          details.classId
        ],
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
      message: "Task saved successfully.",
      task: toTodoItem({ id, ...details, className: classRecord ? classRecord.name : "" })
    });
  } catch (error) {
    console.error("Task creation failed:", error);
    return response.status(500).json({ message: "Unable to save the task right now." });
  }
});

app.put("/api/tasks/:id", requireApiLogin, async (request, response) => {
  const id = getPositiveId(request.params.id);
  if (!id) {
    return response.status(400).json({ message: "Enter a valid task ID." });
  }

  const details = getTaskDetails(request.body);
  if (details.error) {
    return response.status(400).json({ message: details.error });
  }

  try {
    const classRecord = details.classId === null
      ? null
      : await findClassForUser(request.session.userId, details.classId);
    if (details.classId !== null && !classRecord) {
      return response.status(404).json({ message: "Class not found." });
    }

    const changes = await new Promise((resolve, reject) => {
      database.run(
        `UPDATE tasks
         SET item_type = ?, title = ?, notes = ?, task_date = ?, due_date = ?,
             due_time = ?, reminder_days = ?, reminder_date = ?, class_id = ?,
             updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
        [
          details.itemType,
          details.title,
          details.notes,
          details.taskDate,
          details.dueDate,
          details.dueTime,
          details.reminderDays,
          details.reminderDate,
          details.classId,
          id,
          request.session.userId
        ],
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
      return response.status(404).json({ message: "Task not found." });
    }

    return response.json({
      message: "Task updated successfully.",
      task: toTodoItem({ id, ...details, className: classRecord ? classRecord.name : "" })
    });
  } catch (error) {
    console.error("Task update failed:", error);
    return response.status(500).json({ message: "Unable to update the task right now." });
  }
});

app.delete("/api/tasks/:id", requireApiLogin, async (request, response) => {
  const id = getPositiveId(request.params.id);
  if (!id) {
    return response.status(400).json({ message: "Enter a valid task ID." });
  }

  try {
    const changes = await new Promise((resolve, reject) => {
      database.run(
        "DELETE FROM tasks WHERE id = ? AND user_id = ?",
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
      return response.status(404).json({ message: "Task not found." });
    }

    return response.json({ message: "Task deleted successfully." });
  } catch (error) {
    console.error("Task deletion failed:", error);
    return response.status(500).json({ message: "Unable to delete the task right now." });
  }
});

app.post("/api/classes", requireApiLogin, async (request, response) => {
  const details = getClassDetails(request.body);
  if (details.error) {
    return response.status(400).json({ message: details.error });
  }

  try {
    const semester = await findSemesterForUser(request.session.userId, details.semesterId);
    if (!semester) {
      return response.status(404).json({ message: "Semester not found." });
    }

    const id = await new Promise((resolve, reject) => {
      database.run(
        `INSERT INTO classes (user_id, semester_id, name, meeting_days, start_time, end_time, location)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          request.session.userId,
          details.semesterId,
          details.name,
          JSON.stringify(details.meetingDays),
          details.startTime,
          details.endTime,
          details.location
        ],
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
      message: "Class created successfully.",
      class: {
        id,
        ...details,
        semesterStartDate: semester.startDate,
        semesterEndDate: semester.endDate
      }
    });
  } catch (error) {
    console.error("Class creation failed:", error);
    return response.status(500).json({ message: "Unable to save the class right now." });
  }
});

app.put("/api/classes/:id", requireApiLogin, async (request, response) => {
  const id = getPositiveId(request.params.id);
  if (!id) {
    return response.status(400).json({ message: "Enter a valid class ID." });
  }

  const details = getClassDetails(request.body);
  if (details.error) {
    return response.status(400).json({ message: details.error });
  }

  try {
    const semester = await findSemesterForUser(request.session.userId, details.semesterId);
    if (!semester) {
      return response.status(404).json({ message: "Semester not found." });
    }

    const changes = await new Promise((resolve, reject) => {
      database.run(
        `UPDATE classes
         SET semester_id = ?, name = ?, meeting_days = ?, start_time = ?, end_time = ?, location = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
        [
          details.semesterId,
          details.name,
          JSON.stringify(details.meetingDays),
          details.startTime,
          details.endTime,
          details.location,
          id,
          request.session.userId
        ],
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
      return response.status(404).json({ message: "Class not found." });
    }

    return response.json({
      message: "Class updated successfully.",
      class: {
        id,
        ...details,
        semesterStartDate: semester.startDate,
        semesterEndDate: semester.endDate
      }
    });
  } catch (error) {
    console.error("Class update failed:", error);
    return response.status(500).json({ message: "Unable to update the class right now." });
  }
});

app.get("/api/classes", requireApiLogin, async (request, response) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      database.all(
        `SELECT c.id, c.name, c.meeting_days AS meetingDays,
                c.start_time AS startTime, c.end_time AS endTime,
                c.location, c.semester_id AS semesterId,
                s.start_date AS semesterStartDate, s.end_date AS semesterEndDate
         FROM classes c
         LEFT JOIN semesters s ON s.id = c.semester_id AND s.user_id = c.user_id
         WHERE c.user_id = ?
         ORDER BY s.start_date, c.name, c.id`,
        [request.session.userId],
        (error, results) => error ? reject(error) : resolve(results)
      );
    });

    const classes = rows.map((classRecord) => ({
      ...classRecord,
      meetingDays: JSON.parse(classRecord.meetingDays)
    }));

    return response.json({ classes });
  } catch (error) {
    console.error("Class list failed:", error);
    return response.status(500).json({ message: "Unable to load classes right now." });
  }
});

app.delete("/api/classes/:id", requireApiLogin, async (request, response) => {
  const id = getPositiveId(request.params.id);
  if (!id) {
    return response.status(400).json({ message: "Enter a valid class ID." });
  }

  try {
    const changes = await new Promise((resolve, reject) => {
      database.run(
        "DELETE FROM classes WHERE id = ? AND user_id = ?",
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
      return response.status(404).json({ message: "Class not found." });
    }

    return response.json({ message: "Class deleted successfully." });
  } catch (error) {
    console.error("Class deletion failed:", error);
    return response.status(500).json({ message: "Unable to delete the class right now." });
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
