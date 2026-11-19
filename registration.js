const registrationForm = document.getElementById("registration-form");
const registrationMessage = document.getElementById("registration-message");

registrationForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = document.getElementById("name").value.trim();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

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

  registrationMessage.textContent = `Registration form submitted for ${email}.`;
  registrationMessage.className = "auth-message success";
  registrationForm.reset();
});
