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

document.addEventListener("DOMContentLoaded", function () {
  var overlay = document.getElementById("search-overlay");
  var input = document.getElementById("search-input");
  var results = document.getElementById("search-results");
  var closeBtn = document.querySelector(".search-close");
  var toggles = document.querySelectorAll(".search-toggle");

  if (!overlay || !input || !results || toggles.length === 0) return;

  var pages = null;
  var pagesPromise = null;
  var activeIndex = -1;

  function loadPages() {
    if (!pagesPromise) {
      pagesPromise = fetch("/search-index.json")
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          pages = data;
          return data;
        })
        .catch(function () {
          pages = [];
          return [];
        });
    }
    return pagesPromise;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlight(text, tokens) {
    var escaped = escapeHtml(text);
    var validTokens = tokens.filter(function (t) {
      return t.length > 0;
    });
    if (validTokens.length === 0) return escaped;
    var pattern = new RegExp("(" + validTokens.map(escapeRegExp).join("|") + ")", "gi");
    return escaped.replace(pattern, "<mark>$1</mark>");
  }

  function scorePage(page, tokens, requireAll) {
    var title = page.title.toLowerCase();
    var desc = (page.description || "").toLowerCase();
    var url = page.url.toLowerCase();
    var score = 0;
    var matchedAny = false;

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      var matched = false;
      var titleIdx = title.indexOf(t);
      if (titleIdx !== -1) {
        score += titleIdx === 0 ? 5 : 3;
        matched = true;
      }
      if (url.indexOf(t) !== -1) {
        score += 2;
        matched = true;
      }
      if (desc.indexOf(t) !== -1) {
        score += 1;
        matched = true;
      }
      if (matched) {
        matchedAny = true;
      } else if (requireAll) {
        return -1;
      }
    }

    return matchedAny ? score : -1;
  }

  function search(query) {
    var tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter(function (t) {
        return t.length > 0;
      });

    if (tokens.length === 0 || !pages) return [];

    var scored = pages
      .map(function (page) {
        return { page: page, score: scorePage(page, tokens, true) };
      })
      .filter(function (entry) {
        return entry.score !== -1;
      });

    if (scored.length === 0) {
      scored = pages
        .map(function (page) {
          return { page: page, score: scorePage(page, tokens, false) };
        })
        .filter(function (entry) {
          return entry.score !== -1;
        });
    }

    scored.sort(function (a, b) {
      return b.score - a.score;
    });

    return scored.slice(0, 8).map(function (entry) {
      return entry.page;
    });
  }

  function render(query) {
    var tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter(function (t) {
        return t.length > 0;
      });

    activeIndex = -1;

    if (tokens.length === 0) {
      results.innerHTML = '<p class="search-status">Start typing to find a suburb, pest or service.</p>';
      return;
    }

    if (!pages) {
      results.innerHTML = '<p class="search-status">Loading…</p>';
      return;
    }

    var matches = search(query);

    if (matches.length === 0) {
      results.innerHTML =
        '<p class="search-status">No matches for &ldquo;' +
        escapeHtml(query) +
        '&rdquo;. Try a suburb or pest name, or <a href="tel:0261059771">call 02 6105 9771</a>.</p>';
      return;
    }

    results.innerHTML = matches
      .map(function (page, i) {
        return (
          '<a class="search-result" href="' +
          page.url +
          '" data-index="' +
          i +
          '">' +
          '<div class="search-result-title">' +
          highlight(page.title, tokens) +
          "</div>" +
          (page.description
            ? '<div class="search-result-desc">' + highlight(page.description, tokens) + "</div>"
            : "") +
          '<div class="search-result-url">' +
          page.url +
          "</div>" +
          "</a>"
        );
      })
      .join("");
  }

  function setActive(index) {
    var items = results.querySelectorAll(".search-result");
    if (items.length === 0) return;
    if (index < 0) index = items.length - 1;
    if (index >= items.length) index = 0;
    items.forEach(function (item) {
      item.classList.remove("is-active");
    });
    items[index].classList.add("is-active");
    items[index].scrollIntoView({ block: "nearest" });
    activeIndex = index;
  }

  function openSearch() {
    overlay.hidden = false;
    document.body.classList.add("search-open");
    render(input.value);
    loadPages().then(function () {
      render(input.value);
    });
    input.focus();
  }

  function closeSearch() {
    overlay.hidden = true;
    document.body.classList.remove("search-open");
  }

  toggles.forEach(function (toggle) {
    toggle.addEventListener("click", openSearch);
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", closeSearch);
  }

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeSearch();
  });

  input.addEventListener("input", function () {
    render(input.value);
  });

  input.addEventListener("keydown", function (e) {
    var items = results.querySelectorAll(".search-result");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setActive(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) setActive(activeIndex - 1);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        window.location.href = items[activeIndex].getAttribute("href");
      } else if (items.length > 0) {
        e.preventDefault();
        window.location.href = items[0].getAttribute("href");
      }
    }
  });

  document.addEventListener("keydown", function (e) {
    if (!overlay.hidden && e.key === "Escape") {
      closeSearch();
      return;
    }
    var tag = document.activeElement ? document.activeElement.tagName : "";
    var isTyping = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable;
    if (overlay.hidden && !isTyping && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"))) {
      e.preventDefault();
      openSearch();
    }
  });
});
