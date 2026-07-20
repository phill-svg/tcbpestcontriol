document.addEventListener("DOMContentLoaded", function () {
  var panel = document.getElementById("site-chat");
  if (!panel) return;

  var intakeEl = panel.querySelector("[data-chat-intake]");
  var intakeForm = panel.querySelector("[data-chat-intake-form]");
  var messagesEl = panel.querySelector("[data-chat-messages]");
  var form = panel.querySelector("[data-chat-form]");
  var input = panel.querySelector("[data-chat-input]");
  var triggers = document.querySelectorAll("[data-chat-open]");
  var closers = panel.querySelectorAll("[data-chat-close]");

  var STORAGE_KEY = "tcb_chat_cid";
  var NAME_KEY = "tcb_chat_name";
  var EMAIL_KEY = "tcb_chat_email";
  var PHONE_KEY = "tcb_chat_phone";
  var conversationId = null;
  var visitorName = null;
  var visitorEmail = null;
  var visitorPhone = null;
  // The page the visitor was on when they opened the chat -- sent to staff so
  // they know what the enquiry is about (e.g. /termite-treatment).
  var visitorPage = null;
  try {
    visitorPage = window.location.pathname + window.location.search;
  } catch (e) {}
  var lastSeenId = 0;
  var socket = null;
  var reconnectDelay = 1000;
  var hasOpened = false;
  var lastFocused = null;
  var subtitleEl = panel.querySelector(".chat-header-subtitle");
  var typingRow = null;
  var typingTimer = null;
  var pendingQueue = [];
  var lastTypingSent = 0;

  function getConversationId() {
    if (conversationId) return conversationId;
    try {
      conversationId = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {}
    if (!conversationId) {
      conversationId =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(16).slice(2);
      try {
        window.localStorage.setItem(STORAGE_KEY, conversationId);
      } catch (e) {}
    }
    return conversationId;
  }

  function loadVisitorInfo() {
    try {
      visitorName = window.localStorage.getItem(NAME_KEY);
      visitorEmail = window.localStorage.getItem(EMAIL_KEY);
      visitorPhone = window.localStorage.getItem(PHONE_KEY);
    } catch (e) {}
  }

  function saveVisitorInfo(name, email, phone) {
    visitorName = name;
    visitorEmail = email;
    visitorPhone = phone;
    try {
      window.localStorage.setItem(NAME_KEY, name);
      window.localStorage.setItem(EMAIL_KEY, email);
      window.localStorage.setItem(PHONE_KEY, phone);
    } catch (e) {}
  }

  function hasVisitorInfo() {
    return !!(visitorName && visitorEmail);
  }

  function clearHint() {
    var hint = messagesEl.querySelector(".chat-hint");
    if (hint) hint.remove();
  }

  function formatTimestamp(ms) {
    var d = new Date(ms);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // iOS Safari has a long-standing bug where the page can stay zoomed in
  // after the on-screen keyboard closes (e.g. after sending a message),
  // even though nothing on the page actually needs zooming -- the user is
  // stuck having to manually pinch out. Briefly forcing a maximum-scale
  // constraint right as the keyboard closes makes Safari recompute and
  // snap the effective zoom back to normal; removing it again straight
  // after restores normal pinch-to-zoom.
  function resetViewportZoom() {
    var viewportMeta = document.querySelector('meta[name="viewport"]');
    if (!viewportMeta) return;
    var original = viewportMeta.getAttribute("content");
    viewportMeta.setAttribute("content", original + ", maximum-scale=1.0");
    window.setTimeout(function () {
      viewportMeta.setAttribute("content", original);
    }, 100);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // The header subtitle doubles as a live connection status once the visitor
  // is in the chat: "Online" / "Connecting…" / "Reconnecting…".
  function setConnectionStatus(text) {
    if (subtitleEl) subtitleEl.textContent = text;
  }

  // A "TCB is typing…" bubble shown while a staff member is composing a reply.
  // Purely visual and ephemeral; auto-hides if no further signal arrives.
  function showTyping() {
    clearHint();
    if (!typingRow) {
      typingRow = document.createElement("div");
      typingRow.className = "chat-message chat-message-theirs chat-typing";
      var bubble = document.createElement("div");
      bubble.className = "chat-message-bubble chat-typing-bubble";
      bubble.setAttribute("aria-label", "TCB is typing");
      bubble.innerHTML =
        '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';
      typingRow.appendChild(bubble);
      messagesEl.appendChild(typingRow);
      scrollToBottom();
    }
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(hideTyping, 4000);
  }

  function hideTyping() {
    window.clearTimeout(typingTimer);
    if (typingRow) {
      typingRow.remove();
      typingRow = null;
    }
  }

  // scroll defaults to true -- pass false when batch-rendering (e.g. chat
  // history) so the caller can scroll once after the whole batch is in the
  // DOM instead of forcing a synchronous layout reflow after every message.
  function renderMessage(message, trackId, scroll) {
    clearHint();
    var row = document.createElement("div");
    row.className = "chat-message " + (message.sender === "visitor" ? "chat-message-mine" : "chat-message-theirs");

    var bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = message.body;

    var meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = message.createdAt ? formatTimestamp(message.createdAt) : "";

    row.appendChild(bubble);
    row.appendChild(meta);
    messagesEl.appendChild(row);
    if (scroll !== false) scrollToBottom();

    if (trackId !== false && typeof message.id === "number" && message.id > lastSeenId) {
      lastSeenId = message.id;
    }
  }

  function connect() {
    if (socket) return;
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var url =
      protocol +
      "//" +
      window.location.host +
      "/api/chat/ws?cid=" +
      encodeURIComponent(getConversationId()) +
      "&name=" +
      encodeURIComponent(visitorName || "") +
      "&email=" +
      encodeURIComponent(visitorEmail || "") +
      "&phone=" +
      encodeURIComponent(visitorPhone || "") +
      "&page=" +
      encodeURIComponent(visitorPage || "");
    if (lastSeenId) url += "&since=" + lastSeenId;

    setConnectionStatus("Connecting…");
    socket = new WebSocket(url);

    socket.addEventListener("open", function () {
      reconnectDelay = 1000;
      setConnectionStatus("Online");
      flushQueue();
    });

    socket.addEventListener("message", function (event) {
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (data.type === "history") {
        data.messages.forEach(function (m) {
          renderMessage(m, true, false);
        });
        scrollToBottom();
      } else if (data.type === "message") {
        hideTyping();
        renderMessage(data.message);
      } else if (data.type === "typing" && data.from === "staff") {
        showTyping();
      }
    });

    socket.addEventListener("close", function () {
      socket = null;
      hideTyping();
      if (hasOpened) setConnectionStatus("Reconnecting…");
      window.setTimeout(function () {
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
        if (hasOpened) connect();
      }, reconnectDelay);
    });
  }

  function showIntake() {
    intakeEl.hidden = false;
    messagesEl.hidden = true;
    form.hidden = true;
  }

  function showChat() {
    intakeEl.hidden = true;
    messagesEl.hidden = false;
    form.hidden = false;
    // Warm up the empty state with the visitor's first name.
    var hint = messagesEl.querySelector(".chat-hint");
    if (hint && visitorName) {
      hint.textContent = "Hi " + visitorName.split(" ")[0] + " 👋 Send us a message and we'll reply here as soon as we can.";
    }
    if (!hasOpened) {
      hasOpened = true;
      connect();
    }
    input.focus();
  }

  function open() {
    lastFocused = document.activeElement;
    panel.hidden = false;
    loadVisitorInfo();
    if (hasVisitorInfo()) {
      showChat();
    } else {
      showIntake();
    }
  }

  function close() {
    panel.hidden = true;
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  triggers.forEach(function (trigger) {
    trigger.addEventListener("click", open);
  });

  closers.forEach(function (el) {
    el.addEventListener("click", close);
  });

  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  if (intakeForm) {
    intakeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("chat-name").value.trim();
      var email = document.getElementById("chat-email").value.trim();
      var phoneEl = document.getElementById("chat-phone");
      var phone = phoneEl ? phoneEl.value.trim() : "";
      if (!name || !email) return;

      saveVisitorInfo(name, email, phone);
      showChat();
    });
  }

  // The visitor's own message, rendered immediately with a delivery status
  // that reads "Sending…" until the socket actually accepts it, then flips to
  // a timestamp. Returns the meta element so the status can be updated.
  function renderOwnMessage(body) {
    clearHint();
    var row = document.createElement("div");
    row.className = "chat-message chat-message-mine";
    var bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = body;
    var meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.textContent = "Sending…";
    row.appendChild(bubble);
    row.appendChild(meta);
    messagesEl.appendChild(row);
    scrollToBottom();
    return meta;
  }

  function markSent(meta) {
    if (meta) meta.textContent = formatTimestamp(Date.now());
  }

  // Drain anything queued while the socket was down. Called on every (re)open,
  // so a message typed mid-reconnect is delivered rather than silently lost.
  function flushQueue() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    var queued = pendingQueue;
    pendingQueue = [];
    queued.forEach(function (item) {
      socket.send(JSON.stringify({ type: "message", body: item.body }));
      markSent(item.meta);
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = input.value.trim();
    if (!body) return;
    input.value = "";

    var meta = renderOwnMessage(body);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "message", body: body }));
      markSent(meta);
    } else {
      // Offline / reconnecting -- hold it and send when the socket reopens.
      pendingQueue.push({ body: body, meta: meta });
      if (!socket && hasOpened) connect();
    }
  });

  // Let staff see "typing…" too (throttled). Harmless if no dashboard is open.
  input.addEventListener("input", function () {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    var now = Date.now();
    if (now - lastTypingSent < 2000) return;
    lastTypingSent = now;
    socket.send(JSON.stringify({ type: "typing" }));
  });

  input.addEventListener("blur", resetViewportZoom);
});
