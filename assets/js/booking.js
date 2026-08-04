// Booking form -> live availability (GET /api/availability) + auto-book (POST /api/booking).
document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector("[data-booking-form]");
  if (!form) return;

  var serviceSelect = form.querySelector('[name="service"]');
  var dateInput = form.querySelector('[name="date"]');
  var chipsEl = form.querySelector("[data-slot-chips]");
  var hintEl = form.querySelector("[data-slot-hint]");
  var slotInput = form.querySelector("[data-slot-input]");
  var submitBtn = document.querySelector("[data-booking-submit]");
  var errorEl = document.querySelector("[data-booking-error]");
  var successEl = document.querySelector("[data-booking-success]");
  var whenEl = successEl ? successEl.querySelector("[data-booking-when]") : null;

  function val(name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value.trim() : "";
  }

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function toLocalDateStr(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  // Date bounds: tomorrow .. today+28 days (local time). Server enforces the real rules --
  // this is just a sane UI bound so people don't pick same-day or far-future dates.
  if (dateInput) {
    var today = new Date();
    var minDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    var maxDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 28);
    dateInput.min = toLocalDateStr(minDate);
    dateInput.max = toLocalDateStr(maxDate);
  }

  // Prettify "HH:MM" (24h) -> "9:00 am" (12h, no leading zero).
  function prettyTime(hhmm) {
    var parts = hhmm.split(":");
    var h = parseInt(parts[0], 10);
    var m = parts[1] || "00";
    var suffix = h >= 12 ? "pm" : "am";
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + m + " " + suffix;
  }

  function clearSlotSelection() {
    if (slotInput) slotInput.value = "";
  }

  function clearChips() {
    if (chipsEl) chipsEl.innerHTML = "";
  }

  function setHint(text) {
    if (hintEl) {
      hintEl.textContent = text;
      hintEl.hidden = !text;
    }
  }

  function renderSlots(slots) {
    clearChips();
    if (!slots.length) {
      setHint("No times available that day — try another date or call us.");
      return;
    }
    setHint("Select a time.");
    slots.forEach(function (slot) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "slot-chip";
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", "false");
      chip.setAttribute("data-start-iso", slot.startIso);
      chip.setAttribute("data-start-label", slot.start);
      chip.textContent = prettyTime(slot.start);
      chipsEl.appendChild(chip);
    });
  }

  function fetchAvailability() {
    var service = serviceSelect ? serviceSelect.value : "";
    var date = dateInput ? dateInput.value : "";
    clearSlotSelection();
    clearChips();
    if (errorEl) errorEl.hidden = true;

    if (!service || !date) {
      setHint("Choose a service and date to see available times.");
      return;
    }

    setHint("Loading times…");
    if (chipsEl) chipsEl.classList.add("is-loading");

    return fetch("/api/availability?service=" + encodeURIComponent(service) + "&date=" + encodeURIComponent(date))
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { ok: res.ok, data: data };
          });
      })
      .then(function (r) {
        if (chipsEl) chipsEl.classList.remove("is-loading");
        if (!r.ok || !r.data || !r.data.ok) {
          setHint("Couldn't load times — please call 02 6105 9771.");
          return;
        }
        var days = r.data.days || [];
        var slots = (days[0] && days[0].slots) || [];
        renderSlots(slots);
      })
      .catch(function () {
        if (chipsEl) chipsEl.classList.remove("is-loading");
        setHint("Couldn't load times — please call 02 6105 9771.");
      });
  }

  if (serviceSelect) serviceSelect.addEventListener("change", fetchAvailability);
  if (dateInput) dateInput.addEventListener("change", fetchAvailability);

  if (chipsEl) {
    chipsEl.addEventListener("click", function (e) {
      var chip = e.target.closest ? e.target.closest(".slot-chip") : null;
      if (!chip || !chipsEl.contains(chip)) return;
      var chips = chipsEl.querySelectorAll(".slot-chip");
      for (var i = 0; i < chips.length; i++) {
        chips[i].setAttribute("aria-checked", "false");
      }
      chip.setAttribute("aria-checked", "true");
      if (slotInput) slotInput.value = chip.getAttribute("data-start-iso");
      if (errorEl) errorEl.hidden = true;
    });
  }

  function selectedChipLabel() {
    if (!chipsEl) return "";
    var chip = chipsEl.querySelector('.slot-chip[aria-checked="true"]');
    return chip ? chip.getAttribute("data-start-label") : "";
  }

  // "YYYY-MM-DD" -> "Weekday D Mon" (local, no TZ math needed -- date-only string).
  function friendlyDate(dateStr) {
    var parts = dateStr.split("-");
    var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    var weekday = d.toLocaleDateString("en-AU", { weekday: "long" });
    var day = d.getDate();
    var month = d.toLocaleDateString("en-AU", { month: "short" });
    return weekday + " " + day + " " + month;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (errorEl) errorEl.hidden = true;

    // Native validation first (required fields, email format).
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    if (!slotInput || !slotInput.value) {
      if (errorEl) {
        errorEl.textContent = "Please pick an available time.";
        errorEl.hidden = false;
      }
      return;
    }

    var chosenTimeLabel = prettyTime(selectedChipLabel() || "");
    var chosenDate = val("date");

    var payload = {
      name: val("name"),
      email: val("email"),
      phone: val("phone"),
      address: val("address"),
      service: serviceSelect ? serviceSelect.value : "",
      slotStartIso: slotInput.value,
      date: chosenDate,
      message: val("message"),
      company: val("company"), // honeypot -- must stay empty
      turnstileToken: val("cf-turnstile-response"),
    };

    var orig = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Booking…";
    }

    fetch("/api/booking", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { status: res.status, ok: res.ok, data: data };
          });
      })
      .then(function (r) {
        if (!r.ok || !r.data.ok) {
          var err = new Error((r.data && r.data.error) || "Something went wrong — please call 02 6105 9771.");
          err.status = r.status;
          throw err;
        }
        // Success: swap the form for the confirmation.
        if (whenEl) {
          whenEl.textContent = friendlyDate(chosenDate) + ", " + chosenTimeLabel;
        }
        form.hidden = true;
        if (successEl) {
          successEl.hidden = false;
          successEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      })
      .catch(function (err) {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = orig || "Book my time";
        }

        if (err.status === 409) {
          // Refresh the day's slots first -- fetchAvailability() hides the error banner
          // at its start, so set the message *after* it returns or it gets clobbered.
          fetchAvailability();
          if (errorEl) {
            errorEl.textContent = "That time was just taken — please choose another.";
            errorEl.hidden = false;
          }
        } else {
          if (errorEl) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
          }
        }

        // Turnstile tokens are single-use -- reset so a retry gets a fresh one.
        if (window.turnstile) window.turnstile.reset();
      });
  });
});
