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
    var applyShadow = function () {
      if (window.scrollY > 8) {
        header.style.boxShadow = "0 1px 0 rgba(17, 17, 20, 0.04)";
      } else {
        header.style.boxShadow = "none";
      }
    };
    applyShadow();
    window.addEventListener("scroll", applyShadow, { passive: true });
  }

  // The contact form posts straight to Web3Forms, which emails the office but
  // never touches this site's Worker -- so an enquiry from here never became a
  // ServiceM8 job the way a /book booking does. Mirror the submission to
  // /api/contact on the way past so it does.
  //
  // Deliberately additive: the native submit is left to proceed exactly as
  // before, so if this request fails, is blocked, or JS is off entirely, the
  // customer still gets through to Web3Forms and the thank-you page. keepalive
  // is what lets the request outlive the navigation that's about to happen --
  // without it the browser cancels it mid-flight.
  var contactForm = document.querySelector('form[action="https://api.web3forms.com/submit"]');
  if (contactForm) {
    contactForm.addEventListener("submit", function () {
      var value = function (fieldName) {
        var el = contactForm.elements.namedItem(fieldName);
        return el && typeof el.value === "string" ? el.value.trim() : "";
      };
      var botcheck = contactForm.elements.namedItem("botcheck");

      try {
        fetch("/api/contact", {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: value("Name"),
            email: value("Email"),
            phone: value("Phone"),
            service: value("Service"),
            message: value("Message"),
            botcheck: botcheck && botcheck.checked ? "1" : "",
          }),
        }).catch(function () {});
      } catch (e) {
        // Never let a problem here block the real submission.
      }
    });
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
            var form = document.querySelector('form[action="https://api.web3forms.com/submit"]');
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
            setValue("Name", input.name);
            setValue("Email", input.email);
            setValue("Phone", input.phone);
            setValue("Service", input.service);
            setValue("Message", input.message);
            form.requestSubmit();
            return { status: "submitted" };
          },
        },
      ],
    });
  }
});
