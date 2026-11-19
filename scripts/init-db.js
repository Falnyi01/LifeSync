const { database, databasePath, initializeDatabase } = require("../database/database");

initializeDatabase()
  .then(() => {
    database.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
      (error, row) => {
        if (error) {
          console.error("Could not verify the users table:", error.message);
          process.exitCode = 1;
        } else if (!row) {
          console.error("The users table was not created.");
          process.exitCode = 1;
        } else {
          console.log(`Database initialized at ${databasePath}`);
          console.log("Users table is ready.");
        }

        database.close();
      }
    );
  })
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    database.close();
    process.exitCode = 1;
  });
