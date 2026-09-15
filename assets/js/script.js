document.addEventListener("DOMContentLoaded", function () {
  var toggle = document.querySelector(".menu-toggle");
  var mobileNav = document.querySelector(".mobile-nav");

  if (toggle && mobileNav) {
    toggle.addEventListener("click", function () {
      var isOpen = mobileNav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      toggle.innerHTML = isOpen
        ? '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'
        : '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16"></path><path d="M4 18h16"></path><path d="M4 6h16"></path></svg>';
    });

    mobileNav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        mobileNav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Dropdowns in the header menu. A parent item's words stay a link to its
  // page; the arrow beside them opens the list. On desktop hover and focus open
  // it too, from CSS -- this handles the arrow, which is the only way in on a
  // phone and the keyboard's way in everywhere.
  //
  // The arrow is a <button>, not a link, so the mobile-menu handler above never
  // sees it: tapping the arrow opens the list without closing the menu.
  function closeDropdowns(except) {
    document.querySelectorAll(".nav-item.is-open").forEach(function (item) {
      if (item === except) return;
      item.classList.remove("is-open");
      var button = item.querySelector(".nav-expand");
      if (button) button.setAttribute("aria-expanded", "false");
    });
  }

  document.querySelectorAll(".nav-expand").forEach(function (button) {
    button.addEventListener("click", function () {
      var item = button.closest(".nav-item");
      var open = !item.classList.contains("is-open");
      closeDropdowns(item);
      item.classList.toggle("is-open", open);
      item.classList.remove("is-dismissed");
      button.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  document.querySelectorAll(".nav-item").forEach(function (item) {
    // Escape marks a dropdown dismissed so CSS hover and focus stop holding it
    // open; leaving it, by pointer or by focus, makes it openable again.
    item.addEventListener("mouseleave", function () {
      item.classList.remove("is-dismissed");
    });
    item.addEventListener("focusout", function (event) {
      if (!item.contains(event.relatedTarget)) item.classList.remove("is-dismissed");
    });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    closeDropdowns(null);

    // A dropdown can be held open two ways, and Escape has to beat both. By
    // focus is the obvious one. By hover is the one that is easy to miss: the
    // pointer resting on a menu leaves focus on the page itself, so looking
    // only at the focused element finds nothing to dismiss and the list stays
    // open under the cursor.
    document.querySelectorAll(".nav-item:hover").forEach(function (item) {
      item.classList.add("is-dismissed");
    });

    var active = document.activeElement;
    var focused = active && active.closest ? active.closest(".nav-item") : null;
    if (focused) {
      focused.classList.add("is-dismissed");
      // Back to the arrow, so keyboard focus is not left inside a list that
      // has just disappeared.
      var button = focused.querySelector(".nav-expand");
      if (button) button.focus();
    }
  });

  document.addEventListener("click", function (event) {
    if (!event.target.closest || !event.target.closest(".nav-item")) closeDropdowns(null);
  });

  var header = document.querySelector(".site-header");
  if (header) {
    // The shadow only has two states, so only write the style when the state
    // actually flips. Writing it on every scroll event invalidated layout each
    // time, and the next event's window.scrollY read then had to force a fresh
    // one to answer -- read/write/read/write all the way down a scroll, which
    // is what Lighthouse reports as a forced reflow.
    var hasShadow = null;
    var applyShadow = function () {
      var wantsShadow = window.scrollY > 8;
      if (wantsShadow === hasShadow) return;
      hasShadow = wantsShadow;
      header.style.boxShadow = wantsShadow ? "0 1px 0 rgba(17, 17, 20, 0.04)" : "none";
    };

    window.addEventListener("scroll", applyShadow, { passive: true });

    // Deliberately not called here. Reading window.scrollY during
    // DOMContentLoaded makes the browser lay the whole page out on the spot to
    // answer -- Lighthouse measured 39ms of it, spent before the first paint,
    // to decide something that is almost always "no shadow". The initial state
    // only differs from that when the page opens already scrolled: a reload
    // part-way down, or a link to a #fragment. By load the layout is settled
    // and the same read is free.
    window.addEventListener("load", applyShadow, { once: true });
  }

  // Click-to-call, reported to GA4 the same way the booking and enquiry forms
  // report themselves.
  //
  // This was the gap that kept the conversion count near zero: the site has
  // ~800 tel: links and not one of them told GA4 anything, so the only leads
  // it could ever see were the minority who fill a form in. For a business
  // most people ring, that is the wrong end of the funnel to be measuring.
  //
  // Sent as generate_lead so ONE key event in GA4 Admin covers every way the
  // website produces work. lead_type is what keeps them honest apart: a click
  // is intent, not a completed call -- nothing on the page can know whether
  // they went through with it -- so any report that needs confirmed work
  // filters to lead_type = booking.
  //
  // Delegated from the document, so it covers every tel: link on the page
  // (header, hero, footer, the sticky mobile bar) and any added later. In the
  // capture phase so it still runs if something else stops the event first,
  // and wrapped in try/catch because an ad blocker eating zaraz must never
  // interfere with a customer placing a call.
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      var link = target && target.closest ? target.closest('a[href^="tel:"]') : null;
      if (!link) return;
      try {
        if (window.zaraz && typeof window.zaraz.track === "function") {
          window.zaraz.track("generate_lead", {
            lead_type: "phone_call",
            // Which page earned the call -- the useful half of the report.
            page_path: window.location.pathname,
          });
        }
      } catch (analyticsError) {
        /* never let reporting get between a customer and the phone */
      }
    },
    true
  );

  if (navigator.modelContext && typeof navigator.modelContext.provideContext === "function") {
    navigator.modelContext.provideContext({
      tools: [
        {
          name: "request_pest_control_quote",
          description:
            "Request a pest control quote from TCB Pest Control Canberra by submitting the site's enquiry form. Only works on the /contact page — if called elsewhere, returns the contact page URL to navigate to first.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Full name of the person requesting the quote." },
              email: { type: "string", format: "email", description: "Email address for the reply." },
              phone: { type: "string", description: "Optional contact phone number." },
              service: {
                type: "string",
                enum: [
                  "Residential",
                  "Commercial",
                  "Termites",
                  "Ants/Spiders/Cockroaches",
                  "Rodents",
                  "Wasps/Bees",
                  "Moths/Silverfish",
                  "Something else",
                ],
                description: "The type of pest control service being requested.",
              },
              message: {
                type: "string",
                description: "Details about the property, the pest, and preferred visit timing.",
              },
            },
            required: ["name", "email", "service", "message"],
          },
          execute: function (input) {
            var form = document.querySelector('form[action="/api/contact"]');
            if (!form) {
              return {
                status: "navigate_required",
                url: "https://www.tcbpestcontrolcanberra.com.au/contact",
                detail: "Navigate to the contact page, then call this tool again to submit the enquiry.",
              };
            }
            var setValue = function (fieldName, value) {
              var el = form.elements.namedItem(fieldName);
              if (el && value != null) el.value = value;
            };
            setValue("name", input.name);
            setValue("email", input.email);
            setValue("phone", input.phone);
            setValue("service", input.service);
            setValue("message", input.message);
            form.requestSubmit();
            return { status: "submitted" };
          },
        },
      ],
    });
  }
});
