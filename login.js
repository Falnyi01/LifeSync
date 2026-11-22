const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const submitButton = loginForm.querySelector('button[type="submit"]');

  if (!email || !password) {
    loginMessage.textContent = "Enter your email and password.";
    loginMessage.className = "auth-message error";
    return;
  }

  submitButton.disabled = true;
  loginMessage.textContent = "Logging in...";
  loginMessage.className = "auth-message";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const result = await response.json();

    if (!response.ok) {
      loginMessage.textContent = result.message || "Could not log in.";
      loginMessage.className = "auth-message error";
      return;
    }

    loginForm.reset();
    window.location.assign("/");
  } catch (error) {
    console.error("Login request failed:", error);
    loginMessage.textContent = "Could not connect to LifeSync. Please try again.";
    loginMessage.className = "auth-message error";
  } finally {
    submitButton.disabled = false;
  }
});
