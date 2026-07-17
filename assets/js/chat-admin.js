document.addEventListener("DOMContentLoaded", function () {
  var loginEl = document.querySelector("[data-staff-login]");
  var dashboardEl = document.querySelector("[data-staff-dashboard]");
  var loginForm = document.querySelector("[data-staff-login-form]");
  var errorEl = document.querySelector("[data-staff-login-error]");
  var logoutBtn = document.querySelector("[data-staff-logout]");
  if (!loginEl || !dashboardEl || !loginForm) return;

  function showDashboard() {
    loginEl.hidden = true;
    dashboardEl.hidden = false;
  }

  function showLogin() {
    dashboardEl.hidden = true;
    loginEl.hidden = false;
  }

  function checkSession() {
    fetch("/api/staff/session")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.authenticated) {
          showDashboard();
        } else {
          showLogin();
        }
      })
      .catch(function () {
        showLogin();
      });
  }

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.hidden = true;

    var passcode = document.getElementById("staff-passcode").value;

    fetch("/api/staff/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: passcode }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("login failed");
        return res.json();
      })
      .then(function () {
        loginForm.reset();
        showDashboard();
      })
      .catch(function () {
        errorEl.textContent = "Incorrect passcode.";
        errorEl.hidden = false;
      });
  });

  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      fetch("/api/staff/logout", { method: "POST" }).then(function () {
        showLogin();
      });
    });
  }

  checkSession();
});
