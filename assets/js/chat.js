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
  var conversationId = null;
  var visitorName = null;
  var visitorEmail = null;
  var lastSeenId = 0;
  var socket = null;
  var reconnectDelay = 1000;
  var hasOpened = false;
  var lastFocused = null;

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
    } catch (e) {}
  }

  function saveVisitorInfo(name, email) {
    visitorName = name;
    visitorEmail = email;
    try {
      window.localStorage.setItem(NAME_KEY, name);
      window.localStorage.setItem(EMAIL_KEY, email);
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

  function renderMessage(message, trackId) {
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
    messagesEl.scrollTop = messagesEl.scrollHeight;

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
      encodeURIComponent(visitorEmail || "");
    if (lastSeenId) url += "&since=" + lastSeenId;

    socket = new WebSocket(url);

    socket.addEventListener("open", function () {
      reconnectDelay = 1000;
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
          renderMessage(m);
        });
      } else if (data.type === "message") {
        renderMessage(data.message);
      }
    });

    socket.addEventListener("close", function () {
      socket = null;
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
      if (!name || !email) return;

      saveVisitorInfo(name, email);
      showChat();
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = input.value.trim();
    if (!body || !socket || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({ type: "message", body: body }));
    renderMessage({ sender: "visitor", body: body, createdAt: Date.now() }, false);
    input.value = "";
  });
});
