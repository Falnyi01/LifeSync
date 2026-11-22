const registrationForm = document.getElementById("registration-form");
const registrationMessage = document.getElementById("registration-message");

registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("name").value.trim();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const submitButton = registrationForm.querySelector('button[type="submit"]');

  if (!name || !email || !password) {
    registrationMessage.textContent = "Please complete all fields.";
    registrationMessage.className = "auth-message error";
    return;
  }

  if (password.length < 8) {
    registrationMessage.textContent = "Password must be at least 8 characters.";
    registrationMessage.className = "auth-message error";
    return;
  }

  submitButton.disabled = true;
  registrationMessage.textContent = "Creating your account...";
  registrationMessage.className = "auth-message";

  try {
    const response = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password })
    });
    const result = await response.json();

    if (!response.ok) {
      registrationMessage.textContent = result.message || "Could not create your account.";
      registrationMessage.className = "auth-message error";
      return;
    }

    registrationMessage.textContent = result.message;
    registrationMessage.className = "auth-message success";
    registrationForm.reset();
  } catch (error) {
    console.error("Registration request failed:", error);
    registrationMessage.textContent = "Could not connect to LifeSync. Please try again.";
    registrationMessage.className = "auth-message error";
  } finally {
    submitButton.disabled = false;
  }
});
