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
