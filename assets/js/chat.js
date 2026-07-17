document.addEventListener("DOMContentLoaded", function () {
  var panel = document.getElementById("site-chat");
  if (!panel) return;

  var messagesEl = panel.querySelector("[data-chat-messages]");
  var form = panel.querySelector("[data-chat-form]");
  var input = panel.querySelector("[data-chat-input]");
  var triggers = document.querySelectorAll("[data-chat-open]");
  var closers = panel.querySelectorAll("[data-chat-close]");

  var STORAGE_KEY = "tcb_chat_cid";
  var conversationId = null;
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

  function clearHint() {
    var hint = messagesEl.querySelector(".chat-hint");
    if (hint) hint.remove();
  }

  function renderMessage(message, trackId) {
    clearHint();
    var row = document.createElement("div");
    row.className = "chat-message chat-message-" + (message.sender === "staff" ? "staff" : "visitor");

    var bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = message.body;

    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (trackId !== false && typeof message.id === "number" && message.id > lastSeenId) {
      lastSeenId = message.id;
    }
  }

  function connect() {
    if (socket) return;
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var url = protocol + "//" + window.location.host + "/api/chat/ws?cid=" + encodeURIComponent(getConversationId());
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

  function open() {
    lastFocused = document.activeElement;
    panel.hidden = false;
    if (!hasOpened) {
      hasOpened = true;
      connect();
    }
    input.focus();
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

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = input.value.trim();
    if (!body || !socket || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({ type: "message", body: body }));
    renderMessage({ sender: "visitor", body: body }, false);
    input.value = "";
  });
});
