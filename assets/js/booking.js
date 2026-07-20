// Booking form -> POST /api/booking (creates a ServiceM8 Quote job server-side).
document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector("[data-booking-form]");
  if (!form) return;
  var errorEl = document.querySelector("[data-booking-error]");
  var successEl = document.querySelector("[data-booking-success]");
  var submitBtn = document.querySelector("[data-booking-submit]");

  function val(name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value.trim() : "";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (errorEl) errorEl.hidden = true;

    // Native validation first (required fields, email format).
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    var payload = {
      name: val("name"),
      email: val("email"),
      phone: val("phone"),
      address: val("address"),
      service: val("service"),
      date: val("date"),
      time: val("time"),
      message: val("message"),
      company: val("company"), // honeypot -- must stay empty
    };

    var orig = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }

    fetch("/api/booking", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.data.ok) throw new Error((r.data && r.data.error) || "Something went wrong. Please call us on 02 6105 9771.");
        // Success: swap the form for the confirmation.
        form.hidden = true;
        if (successEl) {
          successEl.hidden = false;
          successEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      })
      .catch(function (err) {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = orig || "Request booking";
        }
        if (errorEl) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        }
      });
  });
});
