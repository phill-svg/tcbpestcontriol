// Booking form -> live availability (GET /api/availability) + auto-book (POST /api/booking).
//
// Display copy of src/booking-config.js's PRICING/MODIFIER_LABELS/MODIFIER_OPTIONS
// -- this is a plain <script> served to the browser, so it can't import the ES
// module the Worker uses. Kept deliberately identical in shape and values so the
// two never drift; the price shown here is DISPLAY ONLY -- the server (via
// computePrice() in booking-config.js, called from index.js's handleBooking)
// is the only place a price is actually decided, and this script never sends
// one -- only the chosen `modifier` / `quoteRequested`.
var PRICING = {
  "general-pest": { modifier: "bedrooms", prices: { "1-3": 249, "4-5": 289, "6+": 349 } },
  "ants-spiders-roaches": { modifier: "bedrooms", prices: { "1-3": 249, "4-5": 289, "6+": 349 } },
  "termite-inspection": { modifier: "property", prices: { subfloor: 320, slab: 289 } },
  "rodents": { modifier: "none", price: 289 },
  "wasps-bees": { modifier: "none", price: 289 },
};
var MODIFIER_LABELS = { bedrooms: "How many bedrooms?", property: "Property type" };
var MODIFIER_OPTIONS = {
  bedrooms: [
    { value: "1-3", label: "1–3 bedrooms" },
    { value: "4-5", label: "4–5 bedrooms" },
    { value: "6+", label: "6 or more bedrooms" },
  ],
  property: [
    { value: "subfloor", label: "With subfloor" },
    { value: "slab", label: "On a slab (no subfloor)" },
  ],
};

function getModifierType(serviceKey) {
  var entry = PRICING[serviceKey];
  return entry ? entry.modifier : "none";
}

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

  // -- Pricing UI ------------------------------------------------------------
  var modifierField = form.querySelector("[data-modifier-field]");
  var modifierLabelEl = form.querySelector("#bk-mod-label");
  var modifierSelect = form.querySelector("#bk-modifier");
  var priceRow = form.querySelector("[data-price-row]");
  var priceAmountEl = form.querySelector("[data-price-amount]");
  var priceNoteEl = form.querySelector("[data-price-note]");
  var quoteToggle = form.querySelector("[data-quote-toggle]");
  var quoteInput = form.querySelector("[data-quote-input]");

  // A custom-quote request is a no-time enquiry, so quote mode hides the whole
  // date + time-slot step; these refs let us show/hide it and swap the success copy.
  var dateField = dateInput ? dateInput.closest(".field") : null;
  var slotsField = chipsEl ? chipsEl.closest(".field") : null;
  var successTitle = successEl ? successEl.querySelector(".staff-login-success-title") : null;
  var successText = successEl ? successEl.querySelector(".staff-login-success-text") : null;

  var DEFAULT_PRICE_NOTE = "Fixed price — no surprises. Includes GST.";
  var QUOTE_PRICE_NOTE = "We'll prepare a custom quote for you — no fixed price.";

  function isQuoteMode() {
    return quoteInput && quoteInput.value === "1";
  }

  function setQuoteMode(on) {
    if (!quoteInput) return;
    quoteInput.value = on ? "1" : "0";
    if (quoteToggle) quoteToggle.textContent = on ? "Use the fixed price instead" : "Prefer a custom quote instead?";
    // Show/hide the date + time-slot step. Drop the date's `required` flag when
    // hidden so a hidden field can't block submit, and relabel the button.
    if (dateField) dateField.hidden = on;
    if (slotsField) slotsField.hidden = on;
    if (dateInput) dateInput.required = !on;
    if (submitBtn) submitBtn.textContent = on ? "Request a quote" : "Book my time";
    if (on) {
      clearSlotSelection();
      if (modifierField) modifierField.hidden = true;
      if (priceRow) priceRow.hidden = false;
      if (priceAmountEl) priceAmountEl.textContent = "";
      if (priceNoteEl) priceNoteEl.textContent = QUOTE_PRICE_NOTE;
    } else {
      if (priceNoteEl) priceNoteEl.textContent = DEFAULT_PRICE_NOTE;
      renderPriceForService();
    }
  }

  // Rebuilds the modifier field + price display for whatever service is
  // currently selected. Called on service change and to restore the normal
  // (non-quote) price display when the quote toggle is switched back off.
  function renderPriceForService() {
    var serviceKey = serviceSelect ? serviceSelect.value : "";
    var entry = PRICING[serviceKey];

    if (!entry) {
      if (modifierField) modifierField.hidden = true;
      if (priceRow) priceRow.hidden = true;
      return;
    }

    var type = getModifierType(serviceKey);
    if (type === "none") {
      if (modifierField) modifierField.hidden = true;
      if (priceRow) priceRow.hidden = false;
      if (priceAmountEl) priceAmountEl.textContent = "$" + entry.price;
      return;
    }

    // bedrooms / property: populate the modifier <select>, show it, and clear
    // the price until the customer actually picks an option.
    if (modifierLabelEl) modifierLabelEl.textContent = MODIFIER_LABELS[type] || "";
    if (modifierSelect) {
      modifierSelect.innerHTML = '<option value="" disabled selected>Select…</option>';
      (MODIFIER_OPTIONS[type] || []).forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        modifierSelect.appendChild(o);
      });
    }
    if (modifierField) modifierField.hidden = false;
    if (priceRow) priceRow.hidden = false;
    if (priceAmountEl) priceAmountEl.textContent = "";
  }

  function onServiceChangeForPricing() {
    setQuoteMode(false); // reset quote mode on every service change
    renderPriceForService();
  }

  function onModifierChange() {
    if (isQuoteMode()) return;
    var serviceKey = serviceSelect ? serviceSelect.value : "";
    var entry = PRICING[serviceKey];
    var value = modifierSelect ? modifierSelect.value : "";
    var amount = entry && entry.prices ? entry.prices[value] : undefined;
    if (priceAmountEl) priceAmountEl.textContent = amount !== undefined ? "$" + amount : "";
  }

  if (serviceSelect) serviceSelect.addEventListener("change", onServiceChangeForPricing);
  if (modifierSelect) modifierSelect.addEventListener("change", onModifierChange);
  if (quoteToggle) {
    quoteToggle.addEventListener("click", function () {
      setQuoteMode(!isQuoteMode());
    });
  }
  // Prime the pricing UI for whatever the service field starts as (usually
  // nothing, but keeps behaviour correct if a browser restores a prior value).
  renderPriceForService();

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

    // A firm time is required for a normal booking, but NOT for a custom-quote
    // request (that's a no-time enquiry).
    if (!isQuoteMode() && (!slotInput || !slotInput.value)) {
      if (errorEl) {
        errorEl.textContent = "Please pick an available time.";
        errorEl.hidden = false;
      }
      return;
    }

    // A service with a bedrooms/property follow-up needs that answer before
    // it has a price -- unless the customer opted into a custom quote instead.
    var serviceKeyForGuard = serviceSelect ? serviceSelect.value : "";
    var modifierType = getModifierType(serviceKeyForGuard);
    var modifierValue = modifierSelect ? modifierSelect.value : "";
    if (!isQuoteMode() && modifierType !== "none" && !modifierValue) {
      if (errorEl) {
        errorEl.textContent = "Please choose an option for that service.";
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
      slotStartIso: isQuoteMode() ? "" : slotInput ? slotInput.value : "",
      date: isQuoteMode() ? "" : chosenDate,
      message: val("message"),
      company: val("company"), // honeypot -- must stay empty
      turnstileToken: val("cf-turnstile-response"),
      // Server computes the actual price from these -- we never send a $ amount.
      modifier: isQuoteMode() ? "" : modifierValue,
      quoteRequested: isQuoteMode() ? "1" : "0",
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
        // Success: swap the form for the confirmation. A quote request gets an
        // enquiry acknowledgement (no time); a booking gets the confirmed time.
        if (isQuoteMode()) {
          if (successTitle) successTitle.textContent = "Quote request received";
          if (successText)
            successText.textContent =
              "Thanks — we'll be in touch with your quote and to arrange a time. For anything urgent, call 02 6105 9771.";
        } else if (whenEl) {
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
