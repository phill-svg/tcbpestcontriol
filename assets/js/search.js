document.addEventListener("DOMContentLoaded", function () {
  var overlay = document.getElementById("site-search");
  if (!overlay) return;

  var input = overlay.querySelector(".search-input");
  var resultsEl = overlay.querySelector(".search-results");
  var triggers = document.querySelectorAll("[data-search-open]");
  var closers = overlay.querySelectorAll("[data-search-close]");

  var index = null;
  var indexPromise = null;
  var activeIndex = -1;
  var currentResults = [];
  var lastFocused = null;

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch("/assets/search-index.json")
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          index = data.map(function (entry) {
            return {
              url: entry.url,
              title: entry.title,
              description: entry.description,
              category: entry.category,
              haystack: (entry.title + " " + entry.description + " " + entry.url).toLowerCase(),
            };
          });
          return index;
        })
        .catch(function () {
          index = [];
          return index;
        });
    }
    return indexPromise;
  }

  function search(query) {
    var words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length || !index) return [];

    var scored = [];
    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      var matchesAll = true;
      var score = 0;

      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (entry.haystack.indexOf(word) === -1) {
          matchesAll = false;
          break;
        }
        var titleLower = entry.title.toLowerCase();
        if (titleLower.indexOf(word) !== -1) score += 10;
        if (titleLower.indexOf(word) === 0) score += 5;
      }

      if (matchesAll) scored.push({ entry: entry, score: score });
    }

    scored.sort(function (a, b) {
      return b.score - a.score || a.entry.title.localeCompare(b.entry.title);
    });

    return scored.slice(0, 8).map(function (s) {
      return s.entry;
    });
  }

  function renderResults(results, query) {
    resultsEl.innerHTML = "";
    currentResults = results;
    activeIndex = -1;

    if (!query.trim()) {
      var hint = document.createElement("div");
      hint.className = "search-hint";
      hint.textContent = "Type to search services, suburbs and articles.";
      resultsEl.appendChild(hint);
      return;
    }

    if (!results.length) {
      var empty = document.createElement("div");
      empty.className = "search-no-results";
      empty.textContent = 'No pages match "' + query.trim() + '".';
      resultsEl.appendChild(empty);
      return;
    }

    results.forEach(function (entry, i) {
      var link = document.createElement("a");
      link.className = "search-result";
      link.href = entry.url;
      link.setAttribute("role", "option");
      link.dataset.index = String(i);

      var cat = document.createElement("span");
      cat.className = "search-result-cat";
      cat.textContent = entry.category;

      var title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = entry.title;

      var desc = document.createElement("span");
      desc.className = "search-result-desc";
      desc.textContent = entry.description;

      link.appendChild(cat);
      link.appendChild(title);
      link.appendChild(desc);
      resultsEl.appendChild(link);
    });
  }

  function setActive(i) {
    var items = resultsEl.querySelectorAll(".search-result");
    if (!items.length) return;

    if (i < 0) i = items.length - 1;
    if (i >= items.length) i = 0;
    activeIndex = i;

    items.forEach(function (el, idx) {
      el.classList.toggle("is-active", idx === activeIndex);
    });
    items[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function open() {
    lastFocused = document.activeElement;
    overlay.hidden = false;
    document.documentElement.classList.add("search-open");
    input.value = "";
    renderResults([], "");
    loadIndex().then(function () {
      input.focus();
    });
  }

  function close() {
    overlay.hidden = true;
    document.documentElement.classList.remove("search-open");
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  triggers.forEach(function (trigger) {
    trigger.addEventListener("click", open);
  });

  closers.forEach(function (el) {
    el.addEventListener("click", close);
  });

  input.addEventListener("input", function () {
    loadIndex().then(function () {
      renderResults(search(input.value), input.value);
    });
  });

  overlay.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && currentResults[activeIndex]) {
        e.preventDefault();
        window.location.href = currentResults[activeIndex].url;
      }
    }
  });

  document.addEventListener("keydown", function (e) {
    if (!overlay.hidden) return;
    var tag = document.activeElement && document.activeElement.tagName;
    var typing = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable;

    if (e.key === "/" && !typing) {
      e.preventDefault();
      open();
    } else if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      open();
    }
  });
});
