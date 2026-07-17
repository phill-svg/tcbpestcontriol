document.addEventListener("DOMContentLoaded", function () {
  var shellEl = document.querySelector(".staff-chat-shell");
  var loginEl = document.querySelector("[data-staff-login]");
  var dashboardEl = document.querySelector("[data-staff-dashboard]");
  var loginForm = document.querySelector("[data-staff-login-form]");
  var errorEl = document.querySelector("[data-staff-login-error]");
  var logoutBtn = document.querySelector("[data-staff-logout]");
  var listEl = document.querySelector("[data-staff-conv-list]");
  var threadPlaceholder = document.querySelector("[data-staff-thread-placeholder]");
  var threadActive = document.querySelector("[data-staff-thread-active]");
  var threadMessagesEl = document.querySelector("[data-staff-thread-messages]");
  var replyForm = document.querySelector("[data-staff-reply-form]");
  var replyInput = document.querySelector("[data-staff-reply-input]");
  var enablePushBtn = document.querySelector("[data-staff-enable-push]");
  var layoutEl = document.querySelector(".staff-chat-layout");
  var threadBackBtn = document.querySelector("[data-staff-thread-back]");
  if (!loginEl || !dashboardEl || !loginForm) return;

  var socket = null;
  var reconnectDelay = 1000;
  var currentList = [];
  var activeConversationId = null;

  function showDashboard() {
    loginEl.hidden = true;
    dashboardEl.hidden = false;
    if (shellEl) shellEl.classList.add("staff-chat-shell-wide");
    connect();
    checkPushSubscription();
  }

  function showLogin() {
    dashboardEl.hidden = true;
    loginEl.hidden = false;
    if (shellEl) shellEl.classList.remove("staff-chat-shell-wide");
    if (layoutEl) layoutEl.classList.remove("is-thread-open");
    if (socket) {
      socket.close();
      socket = null;
    }
    activeConversationId = null;
  }

  function checkSession() {
    fetch("/api/staff/session")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.authenticated) {
          showDashboard();
        } else {
          showLogin();
        }
      })
      .catch(function () {
        showLogin();
      });
  }

  function formatTime(ms) {
    var d = new Date(ms);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function renderConversationList(list) {
    currentList = list;
    listEl.innerHTML = "";

    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "staff-conv-empty";
      empty.textContent = "No conversations yet.";
      listEl.appendChild(empty);
      return;
    }

    list.forEach(function (conv) {
      var item = document.createElement("button");
      item.type = "button";
      item.className =
        "staff-conv-item" +
        (conv.unreadByStaff ? " is-unread" : "") +
        (conv.id === activeConversationId ? " is-active" : "");

      var time = document.createElement("span");
      time.className = "staff-conv-item-time";
      time.textContent = formatTime(conv.lastMessageAt);

      var preview = document.createElement("span");
      preview.className = "staff-conv-item-preview";
      preview.textContent = (conv.lastSender === "staff" ? "You: " : "") + (conv.lastBody || "");

      item.appendChild(time);
      item.appendChild(preview);
      item.addEventListener("click", function () {
        selectConversation(conv.id);
      });
      listEl.appendChild(item);
    });
  }

  function renderThreadMessage(message) {
    var row = document.createElement("div");
    row.className = "chat-message " + (message.sender === "staff" ? "chat-message-mine" : "chat-message-theirs");

    var bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = message.body;

    row.appendChild(bubble);
    threadMessagesEl.appendChild(row);
    threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
  }

  function selectConversation(conversationId) {
    activeConversationId = conversationId;
    renderConversationList(currentList);

    threadPlaceholder.hidden = true;
    threadActive.hidden = false;
    threadMessagesEl.innerHTML = "";
    if (layoutEl) layoutEl.classList.add("is-thread-open");

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "loadConversation", conversationId: conversationId }));
    }
  }

  function connect() {
    if (socket) return;
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(protocol + "//" + window.location.host + "/api/chat/staff/ws");

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

      if (data.type === "conversations") {
        renderConversationList(data.list);
      } else if (data.type === "history" && data.conversationId === activeConversationId) {
        threadMessagesEl.innerHTML = "";
        data.messages.forEach(renderThreadMessage);
      } else if (data.type === "message" && data.conversationId === activeConversationId) {
        renderThreadMessage(data.message);
      }
    });

    socket.addEventListener("close", function () {
      socket = null;
      window.setTimeout(function () {
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
        if (!dashboardEl.hidden) connect();
      }, reconnectDelay);
    });
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function setPushButtonState(subscribed) {
    if (!enablePushBtn) return;
    if (subscribed) {
      enablePushBtn.textContent = "Notifications on";
      enablePushBtn.disabled = true;
    } else {
      enablePushBtn.textContent = "Enable notifications";
      enablePushBtn.disabled = false;
    }
  }

  // Silent check on dashboard load -- never prompts for permission, just
  // reflects whether this browser is already subscribed.
  function checkPushSubscription() {
    if (!enablePushBtn || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      if (enablePushBtn) enablePushBtn.hidden = true;
      return;
    }

    navigator.serviceWorker
      .register("/chat-sw.js")
      .then(function (registration) {
        return registration.pushManager.getSubscription();
      })
      .then(function (subscription) {
        setPushButtonState(!!subscription);
      })
      .catch(function () {
        setPushButtonState(false);
      });
  }

  // Only ever called from the button's click handler -- requesting
  // notification permission outside a direct user gesture is against
  // browser policy (and gets silently ignored or auto-denied anyway).
  function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      window.alert("Push notifications aren't supported in this browser.");
      return;
    }

    Notification.requestPermission().then(function (permission) {
      if (permission !== "granted") return;

      navigator.serviceWorker.ready
        .then(function (registration) {
          return fetch("/api/push/vapid-public-key")
            .then(function (res) {
              return res.text();
            })
            .then(function (publicKey) {
              return registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
              });
            });
        })
        .then(function (subscription) {
          return fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(subscription.toJSON()),
          });
        })
        .then(function () {
          setPushButtonState(true);
        })
        .catch(function (err) {
          window.console && console.error("Push subscribe failed", err);
        });
    });
  }

  if (enablePushBtn) {
    enablePushBtn.addEventListener("click", enablePush);
  }

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.hidden = true;

    var passcode = document.getElementById("staff-passcode").value;

    fetch("/api/staff/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: passcode }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("login failed");
        return res.json();
      })
      .then(function () {
        loginForm.reset();
        showDashboard();
      })
      .catch(function () {
        errorEl.textContent = "Incorrect passcode.";
        errorEl.hidden = false;
      });
  });

  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      fetch("/api/staff/logout", { method: "POST" }).then(function () {
        showLogin();
      });
    });
  }

  if (replyForm) {
    replyForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var body = replyInput.value.trim();
      if (!body || !activeConversationId || !socket || socket.readyState !== WebSocket.OPEN) return;

      socket.send(JSON.stringify({ type: "reply", conversationId: activeConversationId, body: body }));
      replyInput.value = "";
    });
  }

  // Mobile only (see the max-width: 700px rules in style.css) -- desktop
  // shows both panes at once, so there's nothing for this button to do
  // there beyond harmlessly clearing a class with no effect.
  if (threadBackBtn) {
    threadBackBtn.addEventListener("click", function () {
      if (layoutEl) layoutEl.classList.remove("is-thread-open");
    });
  }

  checkSession();
});
