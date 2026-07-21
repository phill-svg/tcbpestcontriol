document.addEventListener("DOMContentLoaded", function () {
  var shellEl = document.querySelector(".staff-chat-shell");
  var loginEl = document.querySelector("[data-staff-login]");
  var dashboardEl = document.querySelector("[data-staff-dashboard]");
  var loginForm = document.querySelector("[data-staff-login-form]");
  var loginTitleEl = document.querySelector("[data-staff-login-title]");
  var loginSubmitBtn = document.querySelector("[data-staff-login-submit]");
  var passcodeField = document.querySelector("[data-staff-passcode-field]");
  var errorEl = document.querySelector("[data-staff-login-error]");
  var logoutBtn = document.querySelector("[data-staff-logout]");
  var listEl = document.querySelector("[data-staff-conv-list]");
  var threadPlaceholder = document.querySelector("[data-staff-thread-placeholder]");
  var threadActive = document.querySelector("[data-staff-thread-active]");
  var threadMessagesEl = document.querySelector("[data-staff-thread-messages]");
  var replyForm = document.querySelector("[data-staff-reply-form]");
  var replyInput = document.querySelector("[data-staff-reply-input]");
  var quickRepliesEl = document.querySelector("[data-staff-quick-replies]");
  var enablePushBtn = document.querySelector("[data-staff-enable-push]");
  var layoutEl = document.querySelector(".staff-chat-layout");
  var threadBackBtn = document.querySelector("[data-staff-thread-back]");
  var threadVisitorEl = document.querySelector("[data-staff-thread-visitor]");
  var manageToggleBtn = document.querySelector("[data-staff-manage-toggle]");
  var managePanel = document.querySelector("[data-staff-manage-panel]");
  var manageListEl = document.querySelector("[data-staff-manage-list]");
  var addStaffForm = document.querySelector("[data-staff-add-form]");
  var manageErrorEl = document.querySelector("[data-staff-manage-error]");
  var newIsAdminCheckbox = document.querySelector("[data-staff-new-is-admin]");
  var signupToggleBtn = document.querySelector("[data-staff-signup-toggle]");
  var resetToggleBtn = document.querySelector("[data-staff-reset-toggle]");
  var passwordFieldEl = document.querySelector("[data-staff-password-field]");
  var usernameLabelEl = document.querySelector('label[for="staff-username"]');
  var resetViewEl = document.querySelector("[data-staff-reset-view]");
  var resetForm = document.querySelector("[data-staff-reset-form]");
  var resetErrorEl = document.querySelector("[data-staff-reset-error]");
  var resetSubmitBtn = document.querySelector("[data-staff-reset-submit]");
  var emailToggleBtn = document.querySelector("[data-staff-email-toggle]");
  var emailPanel = document.querySelector("[data-staff-email-panel]");
  var emailForm = document.querySelector("[data-staff-email-form]");
  var emailErrorEl = document.querySelector("[data-staff-email-error]");
  var emailNoteEl = document.querySelector("[data-staff-email-note]");
  var signupEmailFieldEl = document.querySelector("[data-staff-email-field]");
  var loginSwitchEl = document.querySelector("[data-staff-login-switch]");
  var loginNoteEl = document.querySelector("[data-staff-login-note]");
  var pendingListEl = document.querySelector("[data-staff-pending-list]");
  var pendingBadge = document.querySelector("[data-staff-pending-badge]");
  var loginSubtitleEl = document.querySelector("[data-staff-login-subtitle]");
  var loginHintEl = document.querySelector("[data-staff-login-hint]");
  var loginSuccessEl = document.querySelector("[data-staff-login-success]");
  var successBackBtn = document.querySelector("[data-staff-success-back]");
  var usernameInput = document.getElementById("staff-username");
  var threadAvatarEl = document.querySelector("[data-staff-thread-avatar]");
  var threadStatusBtn = document.querySelector("[data-staff-thread-status-toggle]");
  var leadEl = document.querySelector("[data-staff-lead]");
  var leadDetailsEl = document.querySelector("[data-staff-lead-details]");
  var sm8Btn = document.querySelector("[data-staff-sm8-btn]");
  var sm8Label = document.querySelector("[data-staff-sm8-label]");
  var sm8Note = document.querySelector("[data-staff-sm8-note]");
  var tabButtons = document.querySelectorAll("[data-staff-conv-tab]");
  var teamToggleBtn = document.querySelector("[data-staff-team-toggle]");
  var teamToggleBadge = document.querySelector("[data-staff-team-toggle-badge]");
  var teamPanel = document.querySelector("[data-staff-team-panel]");
  var teamRoomsEl = document.querySelector("[data-staff-team-rooms]");
  var teamThreadEl = document.querySelector("[data-staff-team-thread]");
  var teamThreadTitleEl = document.querySelector("[data-staff-team-thread-title]");
  var teamMessagesEl = document.querySelector("[data-staff-team-messages]");
  var teamBackBtn = document.querySelector("[data-staff-team-back]");
  var teamReplyForm = document.querySelector("[data-staff-team-reply-form]");
  var teamReplyInput = document.querySelector("[data-staff-team-reply-input]");
  var tabNavButtons = document.querySelectorAll("[data-staff-tab]");
  var chatTabBadge = document.querySelector("[data-staff-chat-badge]");
  if (!loginEl || !dashboardEl || !loginForm) return;

  var AVATAR_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

  function initials(name) {
    var trimmed = (name || "").trim();
    if (!trimmed) return "?";
    var parts = trimmed.split(/\s+/);
    var chars = parts.length > 1 ? parts[0][0] + parts[1][0] : trimmed.slice(0, 2);
    return chars.toUpperCase();
  }

  function avatarColor(name) {
    var str = name || "?";
    var hash = 0;
    for (var i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function paintAvatar(el, name) {
    if (!el) return;
    el.textContent = initials(name);
    el.style.background = avatarColor(name);
  }

  var socket = null;
  var reconnectDelay = 1000;
  var openList = [];
  var closedList = [];
  var activeTab = "open";
  var activeConversationId = null;
  var bootstrapMode = false;
  var signupMode = false;
  var resetMode = false;
  var isAdmin = false;
  var myUsername = null;
  var teamStaffList = [];
  var teamUnread = {};
  var activeTeamRoom = null;
  // Which top-level dashboard section is showing (customer chat / team /
  // manage / email). Distinct from activeTab above, which is the Open/Closed
  // conversation filter inside the customer-chat section.
  var activeSection = "chat";
  var chatUnread = 0;

  function findConversation(conversationId) {
    var all = openList.concat(closedList);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === conversationId) return all[i];
    }
    return null;
  }

  function showDashboard() {
    // Blur whatever's focused (almost always the username/password field
    // right after a successful sign-in) before hiding the login form --
    // otherwise iOS Safari can leave its autofill suggestion strip stuck
    // rendered at the top of the screen even though the field it belonged
    // to is now hidden.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    loginEl.hidden = true;
    dashboardEl.hidden = false;
    if (shellEl) shellEl.classList.add("staff-chat-shell-wide");
    if (manageToggleBtn) manageToggleBtn.hidden = !isAdmin;
    // Show the customer-chat section by default; hides the other panels.
    chatUnread = 0;
    selectSection("chat");
    // Populate the pending-requests badge on entry so an admin sees waiting
    // requests without opening the panel first.
    loadPendingRequests();
    connect();
    checkPushSubscription();
  }

  function showLogin() {
    dashboardEl.hidden = true;
    loginEl.hidden = false;
    if (shellEl) shellEl.classList.remove("staff-chat-shell-wide");
    if (layoutEl) layoutEl.classList.remove("is-thread-open");
    if (managePanel) managePanel.hidden = true;
    if (teamPanel) teamPanel.hidden = true;
    if (emailPanel) emailPanel.hidden = true;
    if (socket) {
      socket.close();
      socket = null;
    }
    activeConversationId = null;
    activeTeamRoom = null;
    teamStaffList = [];
    teamUnread = {};
    focusUsername();
  }

  // ---- Top-level section tabs --------------------------------------
  // The dashboard shows exactly ONE section at a time. Customer chat is the
  // default. Header buttons carrying data-staff-tab act as tabs; Notifications
  // and Sign out sit outside this group and stay plain actions.
  var sectionEls = {
    chat: layoutEl,
    team: teamPanel,
    manage: managePanel,
    email: emailPanel,
  };

  function updateChatTabBadge() {
    if (!chatTabBadge) return;
    chatTabBadge.textContent = chatUnread;
    chatTabBadge.hidden = chatUnread === 0;
  }

  function selectSection(name) {
    if (!sectionEls[name]) name = "chat";
    activeSection = name;
    Object.keys(sectionEls).forEach(function (key) {
      var el = sectionEls[key];
      if (!el) return;
      var on = key === name;
      el.hidden = !on;
      el.classList.toggle("staff-section-active", on);
    });
    for (var i = 0; i < tabNavButtons.length; i++) {
      var btn = tabNavButtons[i];
      var on = btn.getAttribute("data-staff-tab") === name;
      btn.classList.toggle("is-active", on);
      if (on) {
        btn.setAttribute("aria-current", "true");
      } else {
        btn.removeAttribute("aria-current");
      }
    }
    // Section-specific work when it becomes visible.
    if (name === "chat") {
      chatUnread = 0;
      updateChatTabBadge();
    } else if (name === "team") {
      renderTeamRooms();
    } else if (name === "manage") {
      loadStaffUsers();
      loadPendingRequests();
    } else if (name === "email") {
      var input = document.getElementById("staff-recovery-email");
      if (input) {
        try {
          input.focus();
        } catch (e) {}
      }
    }
  }

  for (var tabIdx = 0; tabIdx < tabNavButtons.length; tabIdx++) {
    tabNavButtons[tabIdx].addEventListener("click", function () {
      selectSection(this.getAttribute("data-staff-tab"));
    });
  }

  // Toggles the login form between "create the first (admin) account"
  // (gated by the one-time ADMIN_PASSCODE secret) and ordinary
  // username/password sign-in, based on whether any staff_users row
  // exists yet on the server.
  function setupLoginForm(needed) {
    bootstrapMode = needed;
    if (loginTitleEl) loginTitleEl.textContent = needed ? "Create the admin account" : "Staff sign in";
    if (loginSubmitBtn) loginSubmitBtn.textContent = needed ? "Create account" : "Sign in";
    if (passcodeField) passcodeField.hidden = !needed;
    var passcodeInput = document.getElementById("staff-passcode");
    if (passcodeInput) passcodeInput.required = needed;
    // Self-service signup is only offered in normal sign-in mode -- during the
    // one-time first-admin bootstrap there's nothing to request access to yet.
    signupMode = false;
    resetMode = false;
    if (signupToggleBtn) signupToggleBtn.textContent = "Create an account";
    if (resetToggleBtn) resetToggleBtn.textContent = "Forgot password?";
    // Undo anything the email-forgot mode may have hidden/relabelled.
    if (passwordFieldEl) passwordFieldEl.hidden = false;
    var pwInput = document.getElementById("staff-password");
    if (pwInput) pwInput.required = true;
    if (usernameLabelEl) usernameLabelEl.textContent = "Username";
    if (signupEmailFieldEl) signupEmailFieldEl.hidden = true;
    var suEmail = document.getElementById("staff-signup-email");
    if (suEmail) suEmail.required = false;
    if (loginSwitchEl) loginSwitchEl.hidden = needed;
    if (loginNoteEl) loginNoteEl.hidden = true;
    if (loginSubtitleEl)
      loginSubtitleEl.textContent = needed
        ? "Set up the first admin account for your team."
        : "Sign in to the team dashboard.";
    if (loginHintEl) loginHintEl.hidden = !needed;
    showLoginForm();
  }

  // Flip the sign-in card between signing in and requesting a new account.
  function setSignupMode(on) {
    signupMode = on;
    if (on) setResetMode(false, true);
    if (errorEl) errorEl.hidden = true;
    if (loginNoteEl) loginNoteEl.hidden = true;
    if (loginTitleEl) loginTitleEl.textContent = on ? "Request staff access" : "Staff sign in";
    if (loginSubmitBtn) loginSubmitBtn.textContent = on ? "Request access" : "Sign in";
    if (signupToggleBtn) signupToggleBtn.textContent = on ? "Back to sign in" : "Create an account";
    if (loginSubtitleEl)
      loginSubtitleEl.textContent = on
        ? "Request an account. An admin approves new members before they can sign in."
        : "Sign in to the team dashboard.";
    if (loginHintEl) loginHintEl.hidden = !on;
    // Signup collects a recovery email so approved accounts can reset by email.
    if (signupEmailFieldEl) signupEmailFieldEl.hidden = !on;
    var signupEmailInput = document.getElementById("staff-signup-email");
    if (signupEmailInput) signupEmailInput.required = on;
    var passwordInput = document.getElementById("staff-password");
    if (passwordInput) passwordInput.setAttribute("autocomplete", on ? "new-password" : "current-password");
  }

  // Flip the sign-in card into "forgot my password" mode: the user enters a
  // username or email and we email them a one-time reset link. Only an
  // identifier is needed, so the password (and the setup-passcode) fields are
  // hidden here. Mutually exclusive with signup mode.
  function setResetMode(on) {
    resetMode = on;
    if (on) {
      signupMode = false;
      if (signupToggleBtn) signupToggleBtn.textContent = "Create an account";
    }
    if (errorEl) errorEl.hidden = true;
    if (loginNoteEl) loginNoteEl.hidden = true;
    if (loginTitleEl) loginTitleEl.textContent = on ? "Reset your password" : "Staff sign in";
    if (loginSubmitBtn) loginSubmitBtn.textContent = on ? "Send reset link" : "Sign in";
    if (resetToggleBtn) resetToggleBtn.textContent = on ? "Back to sign in" : "Forgot password?";
    if (loginSubtitleEl)
      loginSubtitleEl.textContent = on
        ? "Enter your username or email and we'll send you a reset link."
        : "Sign in to the team dashboard.";
    if (loginHintEl) loginHintEl.hidden = true;
    // The setup-passcode field is never used in the email flow.
    if (passcodeField) passcodeField.hidden = true;
    var passcodeInput = document.getElementById("staff-passcode");
    if (passcodeInput) passcodeInput.required = false;
    // Hide the password field entirely -- we only collect an identifier here.
    // A hidden required field would block submit, so drop `required` too.
    if (passwordFieldEl) passwordFieldEl.hidden = on;
    var passwordInput = document.getElementById("staff-password");
    if (passwordInput) {
      passwordInput.required = !on;
      passwordInput.setAttribute("autocomplete", "current-password");
    }
    if (usernameLabelEl) usernameLabelEl.textContent = on ? "Username or email" : "Username";
    // The signup-only email field is never part of the forgot flow.
    if (signupEmailFieldEl) signupEmailFieldEl.hidden = true;
    var sEmailInput = document.getElementById("staff-signup-email");
    if (sEmailInput) sEmailInput.required = false;
  }

  // Default card view: form visible, request-sent success hidden.
  function showLoginForm() {
    if (loginSuccessEl) loginSuccessEl.hidden = true;
    if (loginForm) loginForm.hidden = false;
    if (loginTitleEl) loginTitleEl.hidden = false;
    if (loginSubtitleEl) loginSubtitleEl.hidden = false;
    if (loginSwitchEl) loginSwitchEl.hidden = bootstrapMode;
  }

  // Sets the confirmation-screen heading/body (shared by signup + forgot).
  function setSuccessText(title, text) {
    if (!loginSuccessEl) return;
    var t = loginSuccessEl.querySelector(".staff-login-success-title");
    var x = loginSuccessEl.querySelector(".staff-login-success-text");
    if (t) t.textContent = title;
    if (x) x.textContent = text;
  }

  // After a request is lodged: swap the form for a confirmation screen.
  function showSignupSuccess() {
    if (loginForm) loginForm.hidden = true;
    if (loginSwitchEl) loginSwitchEl.hidden = true;
    if (loginNoteEl) loginNoteEl.hidden = true;
    if (loginTitleEl) loginTitleEl.hidden = true;
    if (loginSubtitleEl) loginSubtitleEl.hidden = true;
    if (loginHintEl) loginHintEl.hidden = true;
    if (loginSuccessEl) loginSuccessEl.hidden = false;
  }

  function focusUsername() {
    if (!usernameInput) return;
    // Skip on touch devices -- auto-popping the keyboard on load is jarring.
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return;
    try {
      usernameInput.focus();
    } catch (e) {}
  }

  function checkSession() {
    fetch("/api/staff/session")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data.authenticated) {
          isAdmin = !!data.isAdmin;
          myUsername = data.username;
          showDashboard();
        } else {
          return fetch("/api/staff/bootstrap-check")
            .then(function (res) {
              return res.json();
            })
            .then(function (bootstrap) {
              setupLoginForm(!!bootstrap.needed);
              showLogin();
            });
        }
      })
      .catch(function () {
        setupLoginForm(false);
        showLogin();
      });
  }

  function formatTime(ms) {
    var d = new Date(ms);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // iOS Safari can leave the page stuck zoomed in after the on-screen
  // keyboard closes (e.g. after sending a reply), even though nothing
  // actually needs zooming. Briefly forcing a maximum-scale constraint
  // right as the keyboard closes makes Safari snap the zoom back to
  // normal; removing it again straight after restores normal pinch-zoom.
  function resetViewportZoom() {
    var viewportMeta = document.querySelector('meta[name="viewport"]');
    if (!viewportMeta) return;
    var original = viewportMeta.getAttribute("content");
    viewportMeta.setAttribute("content", original + ", maximum-scale=1.0");
    window.setTimeout(function () {
      viewportMeta.setAttribute("content", original);
    }, 100);
  }

  function updateTabs() {
    tabButtons.forEach(function (btn) {
      var tab = btn.getAttribute("data-staff-conv-tab");
      btn.classList.toggle("is-active", tab === activeTab);
      var countEl = btn.querySelector("[data-staff-conv-tab-count]");
      if (countEl) countEl.textContent = (tab === "open" ? openList : closedList).length;
    });
  }

  function renderConversationList() {
    var list = activeTab === "open" ? openList : closedList;
    listEl.innerHTML = "";
    updateTabs();

    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "staff-conv-empty";
      empty.innerHTML =
        '<svg aria-hidden="true" class="icon" fill="none" height="30" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" viewBox="0 0 24 24" width="30"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg><p>' +
        (activeTab === "open" ? "No open conversations." : "No closed conversations.") +
        "</p>";
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

      var avatar = document.createElement("span");
      avatar.className = "staff-conv-item-avatar";
      paintAvatar(avatar, conv.visitorName);

      var body = document.createElement("span");
      body.className = "staff-conv-item-body";

      var name = document.createElement("span");
      name.className = "staff-conv-item-name";
      name.textContent = conv.visitorName || "Anonymous";

      var time = document.createElement("span");
      time.className = "staff-conv-item-time";
      time.textContent = formatTime(conv.lastMessageAt);

      var preview = document.createElement("span");
      preview.className = "staff-conv-item-preview";
      preview.textContent = (conv.lastSender === "staff" ? "You: " : "") + (conv.lastBody || "");

      body.appendChild(name);
      body.appendChild(time);
      body.appendChild(preview);
      item.appendChild(avatar);
      item.appendChild(body);
      item.addEventListener("click", function () {
        selectConversation(conv.id);
      });
      listEl.appendChild(item);
    });
  }

  // scroll defaults to true -- pass false when batch-rendering (e.g. thread
  // history) so the caller can scroll once after the whole batch is in the
  // DOM instead of forcing a synchronous layout reflow after every message.
  function renderThreadMessage(message, scroll) {
    var row = document.createElement("div");
    row.className = "chat-message " + (message.sender === "staff" ? "chat-message-mine" : "chat-message-theirs");

    var bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = message.body;

    var meta = document.createElement("div");
    meta.className = "chat-message-meta";
    var metaParts = [];
    if (message.sender === "staff" && message.senderName) metaParts.push(message.senderName);
    if (message.createdAt) metaParts.push(formatTime(message.createdAt));
    meta.textContent = metaParts.join(" · ");

    row.appendChild(bubble);
    row.appendChild(meta);
    threadMessagesEl.appendChild(row);
    if (scroll !== false) threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
  }

  // "Visitor is typing…" indicator inside the open thread. Reuses the shared
  // .chat-typing dots; auto-hides and is cleared when a message arrives or the
  // conversation changes.
  var staffTypingRow = null;
  var staffTypingTimer = null;
  function showVisitorTyping() {
    if (!threadActive || threadActive.hidden) return;
    if (!staffTypingRow) {
      staffTypingRow = document.createElement("div");
      staffTypingRow.className = "chat-message chat-message-theirs chat-typing";
      var bubble = document.createElement("div");
      bubble.className = "chat-message-bubble chat-typing-bubble";
      bubble.setAttribute("aria-label", "Visitor is typing");
      bubble.innerHTML =
        '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';
      staffTypingRow.appendChild(bubble);
      threadMessagesEl.appendChild(staffTypingRow);
      threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
    }
    window.clearTimeout(staffTypingTimer);
    staffTypingTimer = window.setTimeout(hideVisitorTyping, 4000);
  }
  function hideVisitorTyping() {
    window.clearTimeout(staffTypingTimer);
    if (staffTypingRow) {
      staffTypingRow.remove();
      staffTypingRow = null;
    }
  }

  // Soft alert on an incoming visitor message when it isn't already on screen:
  // a short Web Audio beep plus a tab-title flash while the tab is in the
  // background. No audio file needed.
  var audioCtx = null;
  function playNewMessageSound() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.type = "sine";
      o.frequency.value = 660;
      var t = audioCtx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t);
      o.stop(t + 0.3);
    } catch (e) {}
  }

  var baseTitle = document.title;
  var titleFlashing = false;
  function flashTitle() {
    if (!document.hidden) return;
    titleFlashing = true;
    document.title = "🔴 New message";
  }
  function clearTitleFlash() {
    if (titleFlashing) {
      document.title = baseTitle;
      titleFlashing = false;
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) clearTitleFlash();
  });
  window.addEventListener("focus", clearTitleFlash);

  function notifyNewVisitorMessage(conversationId) {
    // Badge the Customer chat tab when a visitor writes in while staff are
    // viewing another section, so a live customer isn't missed behind a
    // hidden tab. Counted before the focus check below so it's always exact.
    if (activeSection !== "chat") {
      chatUnread++;
      updateChatTabBadge();
    }
    // Skip if they're already looking at this exact conversation, tab focused.
    if (conversationId === activeConversationId && !document.hidden) return;
    playNewMessageSound();
    flashTitle();
  }

  function conversationStatus(conversationId) {
    return openList.some(function (c) {
      return c.id === conversationId;
    })
      ? "open"
      : "closed";
  }

  function updateThreadStatusButton(conversationId) {
    if (!threadStatusBtn) return;
    var status = conversationStatus(conversationId);
    threadStatusBtn.textContent = status === "open" ? "Close" : "Reopen";
    threadStatusBtn.dataset.status = status;
  }

  function selectConversation(conversationId) {
    activeConversationId = conversationId;
    renderConversationList();

    threadPlaceholder.hidden = true;
    threadActive.hidden = false;
    threadMessagesEl.innerHTML = "";
    hideVisitorTyping();
    if (layoutEl) layoutEl.classList.add("is-thread-open");

    var conv = findConversation(conversationId);
    if (threadVisitorEl) {
      threadVisitorEl.textContent = conv ? [conv.visitorName, conv.visitorEmail].filter(Boolean).join(" · ") : "";
    }
    if (threadAvatarEl) paintAvatar(threadAvatarEl, conv ? conv.visitorName : "");
    renderLeadPanel(conv);
    updateThreadStatusButton(conversationId);

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "loadConversation", conversationId: conversationId }));
    }
  }

  if (threadStatusBtn) {
    threadStatusBtn.addEventListener("click", function () {
      if (!activeConversationId || !socket || socket.readyState !== WebSocket.OPEN) return;
      var newStatus = threadStatusBtn.dataset.status === "open" ? "closed" : "open";
      socket.send(JSON.stringify({ type: "setConversationStatus", conversationId: activeConversationId, status: newStatus }));
    });
  }

  // ---- Lead panel + "Send to ServiceM8" ----
  var SITE_ORIGIN = "https://www.tcbpestcontrolcanberra.com.au";
  var sm8Force = false;

  function leadRow(label, value, href, newTab) {
    var row = document.createElement("div");
    row.className = "staff-lead-row";
    var l = document.createElement("span");
    l.className = "staff-lead-label";
    l.textContent = label;
    row.appendChild(l);
    var v;
    if (href) {
      v = document.createElement("a");
      v.href = href;
      if (newTab) {
        v.target = "_blank";
        v.rel = "noopener";
      }
    } else {
      v = document.createElement("span");
    }
    v.className = "staff-lead-value";
    v.textContent = value;
    row.appendChild(v);
    return row;
  }

  function renderLeadPanel(conv) {
    if (!leadEl) return;
    if (!conv) {
      leadEl.hidden = true;
      return;
    }
    leadEl.hidden = false;
    if (leadDetailsEl) {
      leadDetailsEl.innerHTML = "";
      if (conv.visitorEmail) leadDetailsEl.appendChild(leadRow("Email", conv.visitorEmail, "mailto:" + conv.visitorEmail, false));
      if (conv.visitorPhone) leadDetailsEl.appendChild(leadRow("Phone", conv.visitorPhone, "tel:" + conv.visitorPhone.replace(/\s+/g, ""), false));
      if (conv.visitorPage) leadDetailsEl.appendChild(leadRow("Page", conv.visitorPage, SITE_ORIGIN + conv.visitorPage, true));
    }
    setSm8State(conv);
  }

  function setSm8State(conv) {
    sm8Force = false;
    if (!sm8Btn) return;
    sm8Btn.disabled = false;
    if (sm8Note) sm8Note.hidden = true;
    if (conv && conv.servicem8JobUuid) {
      if (sm8Label) sm8Label.textContent = "Sent to ServiceM8 ✓";
      sm8Btn.classList.add("is-sent");
      if (sm8Note) {
        sm8Note.hidden = false;
        sm8Note.innerHTML =
          '<a href="https://go.servicem8.com/openjob/' + conv.servicem8JobUuid + '" target="_blank" rel="noopener">Open job in ServiceM8</a>';
      }
    } else {
      if (sm8Label) sm8Label.textContent = "Send to ServiceM8";
      sm8Btn.classList.remove("is-sent");
    }
  }

  function sendToServiceM8(conversationId, force) {
    if (!sm8Btn) return;
    sm8Btn.disabled = true;
    if (sm8Label) sm8Label.textContent = "Sending…";
    if (sm8Note) sm8Note.hidden = true;
    fetch("/api/staff/servicem8/create-job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: conversationId, force: !!force }),
    })
      .then(jsonResult)
      .then(function (r) {
        if (!r.ok) throw new Error((r.data && r.data.error) || "Couldn't create the job.");
        var d = r.data || {};
        if (d.duplicate) {
          // Existing open quote -- let staff open it or deliberately make another.
          sm8Btn.disabled = false;
          sm8Force = true;
          if (sm8Label) sm8Label.textContent = "Create another anyway";
          if (sm8Note) {
            sm8Note.hidden = false;
            sm8Note.innerHTML =
              'This customer already has an open quote. <a href="' +
              d.jobUrl +
              '" target="_blank" rel="noopener">Open it</a>, or click again to create another.';
          }
          return;
        }
        sm8Btn.classList.add("is-sent");
        sm8Btn.disabled = false;
        sm8Force = false;
        if (sm8Label) sm8Label.textContent = "Sent to ServiceM8 ✓";
        if (sm8Note) {
          sm8Note.hidden = false;
          sm8Note.innerHTML =
            '<a href="' +
            d.jobUrl +
            '" target="_blank" rel="noopener">Open job in ServiceM8</a>' +
            (d.reusedCustomer ? " · existing customer reused" : "");
        }
      })
      .catch(function (err) {
        sm8Btn.disabled = false;
        if (sm8Label) sm8Label.textContent = "Send to ServiceM8";
        if (sm8Note) {
          sm8Note.hidden = false;
          sm8Note.textContent = err.message;
        }
      });
  }

  if (sm8Btn) {
    sm8Btn.addEventListener("click", function () {
      if (!activeConversationId || sm8Btn.disabled) return;
      sendToServiceM8(activeConversationId, sm8Force);
    });
  }

  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeTab = btn.getAttribute("data-staff-conv-tab");
      renderConversationList();
    });
  });

  function teamDmRoomId(otherUsername) {
    return "dm:" + [myUsername, otherUsername].sort().join(":");
  }

  function updateTeamToggleBadge() {
    if (!teamToggleBadge) return;
    var total = Object.keys(teamUnread).reduce(function (sum, room) {
      return sum + (teamUnread[room] || 0);
    }, 0);
    teamToggleBadge.textContent = total;
    teamToggleBadge.hidden = total === 0;
  }

  function buildTeamRoomItem(room, label, unread) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "staff-team-room-item";

    var name = document.createElement("span");
    name.className = "staff-team-room-name";
    name.textContent = label;
    btn.appendChild(name);

    if (unread > 0) {
      var badge = document.createElement("span");
      badge.className = "staff-team-room-badge";
      badge.textContent = unread;
      btn.appendChild(badge);
    }

    btn.addEventListener("click", function () {
      openTeamRoom(room, label);
    });
    return btn;
  }

  function renderTeamRooms() {
    if (!teamRoomsEl) return;
    teamRoomsEl.innerHTML = "";
    teamRoomsEl.appendChild(buildTeamRoomItem("team", "Team channel", teamUnread.team || 0));
    teamStaffList.forEach(function (username) {
      var room = teamDmRoomId(username);
      teamRoomsEl.appendChild(buildTeamRoomItem(room, username, teamUnread[room] || 0));
    });
    updateTeamToggleBadge();
  }

  // scroll defaults to true -- pass false when batch-rendering (e.g. room
  // history) so the caller can scroll once after the whole batch is in the
  // DOM instead of forcing a synchronous layout reflow after every message.
  function renderTeamMessage(message, scroll) {
    var row = document.createElement("div");
    row.className = "chat-message " + (message.sender === myUsername ? "chat-message-mine" : "chat-message-theirs");

    var bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = message.body;

    var meta = document.createElement("div");
    meta.className = "chat-message-meta";
    var metaParts = [];
    if (message.sender !== myUsername) metaParts.push(message.sender);
    if (message.createdAt) metaParts.push(formatTime(message.createdAt));
    meta.textContent = metaParts.join(" · ");

    row.appendChild(bubble);
    row.appendChild(meta);
    teamMessagesEl.appendChild(row);
    if (scroll !== false) teamMessagesEl.scrollTop = teamMessagesEl.scrollHeight;
  }

  function openTeamRoom(room, label) {
    activeTeamRoom = room;
    if (teamThreadTitleEl) teamThreadTitleEl.textContent = label;
    if (teamMessagesEl) teamMessagesEl.innerHTML = "";
    if (teamRoomsEl) teamRoomsEl.hidden = true;
    if (teamThreadEl) teamThreadEl.hidden = false;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "loadTeamRoom", room: room }));
    }
  }

  function closeTeamRoom() {
    activeTeamRoom = null;
    if (teamThreadEl) teamThreadEl.hidden = true;
    if (teamRoomsEl) teamRoomsEl.hidden = false;
    renderTeamRooms();
  }

  // Team chat is opened via its header tab (see selectSection); the tab's
  // click handler calls renderTeamRooms when the section becomes visible.

  if (teamBackBtn) {
    teamBackBtn.addEventListener("click", closeTeamRoom);
  }

  if (teamReplyForm) {
    teamReplyForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var body = teamReplyInput.value.trim();
      if (!body || !activeTeamRoom || !socket || socket.readyState !== WebSocket.OPEN) return;

      socket.send(JSON.stringify({ type: "teamMessage", room: activeTeamRoom, body: body }));
      teamReplyInput.value = "";
    });
  }

  if (teamReplyInput) {
    teamReplyInput.addEventListener("blur", resetViewportZoom);
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
        openList = data.open || [];
        closedList = data.closed || [];
        renderConversationList();
        if (activeConversationId) updateThreadStatusButton(activeConversationId);
      } else if (data.type === "history" && data.conversationId === activeConversationId) {
        threadMessagesEl.innerHTML = "";
        data.messages.forEach(function (m) {
          renderThreadMessage(m, false);
        });
        threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
      } else if (data.type === "message") {
        if (data.conversationId === activeConversationId) {
          hideVisitorTyping();
          renderThreadMessage(data.message);
        }
        // Alert on new visitor messages (not our own staff replies).
        if (data.message && data.message.sender === "visitor") {
          notifyNewVisitorMessage(data.conversationId);
        }
      } else if (data.type === "typing" && data.from === "visitor") {
        if (data.conversationId === activeConversationId) showVisitorTyping();
      } else if (data.type === "teamRooms") {
        teamStaffList = data.staff || [];
        teamUnread = data.unread || {};
        if (teamPanel && !teamPanel.hidden && teamRoomsEl && !teamRoomsEl.hidden) {
          renderTeamRooms();
        } else {
          updateTeamToggleBadge();
        }
      } else if (data.type === "teamHistory" && data.room === activeTeamRoom) {
        teamMessagesEl.innerHTML = "";
        data.messages.forEach(function (m) {
          renderTeamMessage(m, false);
        });
        teamMessagesEl.scrollTop = teamMessagesEl.scrollHeight;
      } else if (data.type === "teamMessage" && data.room === activeTeamRoom) {
        renderTeamMessage(data.message);
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
    var label = enablePushBtn.querySelector("span");
    if (subscribed) {
      if (label) label.textContent = "Notifications on";
      enablePushBtn.disabled = true;
    } else {
      if (label) label.textContent = "Enable notifications";
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

  function jsonResult(res) {
    return res.json().then(function (data) {
      return { ok: res.ok, data: data };
    });
  }

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.hidden = true;

    var username = document.getElementById("staff-username").value.trim();
    var password = document.getElementById("staff-password").value;
    var endpoint = bootstrapMode
      ? "/api/staff/bootstrap"
      : resetMode
      ? "/api/staff/forgot"
      : signupMode
      ? "/api/staff/signup"
      : "/api/staff/login";
    var payload;
    if (resetMode) {
      // Email-forgot: just an identifier (username or email).
      payload = { identifier: username };
    } else {
      payload = { username: username, password: password };
      if (bootstrapMode) {
        var passcodeInput = document.getElementById("staff-passcode");
        payload.passcode = passcodeInput ? passcodeInput.value : "";
      }
      if (signupMode) {
        var signupEmailInput = document.getElementById("staff-signup-email");
        payload.email = signupEmailInput ? signupEmailInput.value.trim() : "";
      }
    }

    var wasSignup = signupMode;
    var wasReset = resetMode;
    var originalLabel = loginSubmitBtn ? loginSubmitBtn.textContent : "";
    if (loginSubmitBtn) {
      loginSubmitBtn.disabled = true;
      loginSubmitBtn.textContent = bootstrapMode ? "Creating…" : resetMode ? "Sending…" : wasSignup ? "Sending request…" : "Signing in…";
    }
    function restoreSubmit() {
      if (loginSubmitBtn) {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = originalLabel;
      }
    }

    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(jsonResult)
      .then(function (result) {
        if (!result.ok) throw new Error((result.data && result.data.error) || "Something went wrong.");
        restoreSubmit();
        loginForm.reset();
        if (wasSignup) {
          // Request lodged -- show the confirmation screen; they can't sign in
          // until an admin approves it.
          setSuccessText(
            "Request sent",
            "An admin will review your account. You'll be able to sign in as soon as it's approved."
          );
          showSignupSuccess();
          return;
        }
        if (wasReset) {
          // Generic confirmation regardless of whether the account exists --
          // the server never reveals that, to avoid leaking who has an account.
          setSuccessText(
            "Check your email",
            "If that account exists, we've sent a password reset link. It expires in 1 hour."
          );
          showSignupSuccess();
          return;
        }
        // Re-fetch rather than assuming isAdmin here -- the session
        // endpoint is the single source of truth for it.
        checkSession();
      })
      .catch(function (err) {
        restoreSubmit();
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      });
  });

  if (signupToggleBtn) {
    signupToggleBtn.addEventListener("click", function () {
      setSignupMode(!signupMode);
      focusUsername();
    });
  }

  if (resetToggleBtn) {
    resetToggleBtn.addEventListener("click", function () {
      setResetMode(!resetMode);
      focusUsername();
    });
  }

  if (successBackBtn) {
    successBackBtn.addEventListener("click", function () {
      setSignupMode(false);
      showLoginForm();
      focusUsername();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      fetch("/api/staff/logout", { method: "POST" }).then(function () {
        showLogin();
      });
    });
  }

  function updatePendingBadge(count) {
    if (!pendingBadge) return;
    if (count > 0) {
      pendingBadge.textContent = count;
      pendingBadge.hidden = false;
    } else {
      pendingBadge.hidden = true;
    }
  }

  function renderPendingList(requests) {
    if (!pendingListEl) return;
    pendingListEl.innerHTML = "";
    if (!requests.length) {
      var empty = document.createElement("p");
      empty.className = "staff-manage-empty";
      empty.textContent = "No pending requests.";
      pendingListEl.appendChild(empty);
      return;
    }
    requests.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "staff-manage-item";

      var name = document.createElement("span");
      name.textContent = r.username;
      if (r.email) {
        var em = document.createElement("small");
        em.className = "staff-manage-item-email";
        em.style.display = "block";
        em.style.opacity = "0.7";
        em.textContent = r.email;
        name.appendChild(em);
      }

      var actions = document.createElement("div");
      actions.className = "staff-pending-actions";

      var approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "staff-pending-approve";
      approveBtn.textContent = "Approve";
      approveBtn.addEventListener("click", function () {
        decideRequest("approve", r.username);
      });

      var rejectBtn = document.createElement("button");
      rejectBtn.type = "button";
      rejectBtn.className = "staff-pending-reject";
      rejectBtn.textContent = "Reject";
      rejectBtn.addEventListener("click", function () {
        decideRequest("reject", r.username);
      });

      actions.appendChild(approveBtn);
      actions.appendChild(rejectBtn);
      row.appendChild(name);
      row.appendChild(actions);
      pendingListEl.appendChild(row);
    });
  }

  function loadPendingRequests() {
    if (!isAdmin) return;
    fetch("/api/staff/signup-requests")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        var requests = data.requests || [];
        renderPendingList(requests);
        updatePendingBadge(requests.length);
      })
      .catch(function () {});
  }

  function decideRequest(action, username) {
    if (action === "reject" && !window.confirm('Reject the account request from "' + username + '"?')) return;
    fetch("/api/staff/signup-requests/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username }),
    })
      .then(jsonResult)
      .then(function (result) {
        if (!result.ok) throw new Error((result.data && result.data.error) || "Couldn't update that request.");
        loadPendingRequests();
        loadStaffUsers();
      })
      .catch(function (err) {
        window.alert(err.message);
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

  if (quickRepliesEl) {
    quickRepliesEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".staff-quick-reply");
      if (!btn || !replyInput) return;
      replyInput.value = btn.textContent.trim();
      replyInput.focus();
    });
  }

  if (replyInput) {
    replyInput.addEventListener("blur", resetViewportZoom);
    // Let the visitor see "typing…" -- throttled to at most once every 2s so
    // we're not sending a signal on every keystroke.
    var lastTypingSent = 0;
    replyInput.addEventListener("input", function () {
      if (!activeConversationId || !socket || socket.readyState !== WebSocket.OPEN) return;
      var now = Date.now();
      if (now - lastTypingSent < 2000) return;
      lastTypingSent = now;
      socket.send(JSON.stringify({ type: "typing", conversationId: activeConversationId }));
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

  function renderStaffList(users) {
    manageListEl.innerHTML = "";
    users.forEach(function (u) {
      var row = document.createElement("div");
      row.className = "staff-manage-item";

      var name = document.createElement("span");
      name.textContent = u.username + (u.isAdmin ? " (admin)" : "");

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "staff-manage-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", function () {
        removeStaffUser(u.username);
      });

      row.appendChild(name);
      row.appendChild(removeBtn);
      manageListEl.appendChild(row);
    });
  }

  function loadStaffUsers() {
    fetch("/api/staff/users")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        renderStaffList(data.users || []);
      });
  }

  function removeStaffUser(username) {
    if (!window.confirm('Remove staff account "' + username + '"?')) return;

    fetch("/api/staff/users", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username }),
    })
      .then(jsonResult)
      .then(function (result) {
        if (!result.ok) throw new Error((result.data && result.data.error) || "Couldn't remove that account.");
        loadStaffUsers();
      })
      .catch(function (err) {
        window.alert(err.message);
      });
  }

  // Manage staff is opened via its header tab (see selectSection), which
  // loads the staff + pending lists when the section becomes visible.

  if (addStaffForm) {
    addStaffForm.addEventListener("submit", function (e) {
      e.preventDefault();
      manageErrorEl.hidden = true;

      var username = document.getElementById("staff-new-username").value.trim();
      var password = document.getElementById("staff-new-password").value;
      var newIsAdmin = newIsAdminCheckbox ? newIsAdminCheckbox.checked : false;

      fetch("/api/staff/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username, password: password, isAdmin: newIsAdmin }),
      })
        .then(jsonResult)
        .then(function (result) {
          if (!result.ok) throw new Error((result.data && result.data.error) || "Couldn't add that account.");
          addStaffForm.reset();
          loadStaffUsers();
        })
        .catch(function (err) {
          manageErrorEl.textContent = err.message;
          manageErrorEl.hidden = false;
        });
    });
  }

  // ---- Email password-reset: landing view when the emailed link is opened ----
  function getResetToken() {
    var m = window.location.search.match(/[?&]reset=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  var resetToken = getResetToken();

  function showResetView() {
    if (loginEl) loginEl.hidden = true;
    if (dashboardEl) dashboardEl.hidden = true;
    if (resetViewEl) resetViewEl.hidden = false;
    var pw = document.getElementById("staff-reset-password");
    if (pw) {
      try {
        pw.focus();
      } catch (e) {}
    }
  }

  if (resetForm) {
    resetForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (resetErrorEl) resetErrorEl.hidden = true;
      var pw = document.getElementById("staff-reset-password").value;
      var orig = resetSubmitBtn ? resetSubmitBtn.textContent : "";
      if (resetSubmitBtn) {
        resetSubmitBtn.disabled = true;
        resetSubmitBtn.textContent = "Setting…";
      }
      fetch("/api/staff/reset-with-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resetToken, password: pw }),
      })
        .then(jsonResult)
        .then(function (result) {
          if (!result.ok) throw new Error((result.data && result.data.error) || "Something went wrong.");
          // Strip the token from the address bar, then drop into the dashboard.
          if (window.history && window.history.replaceState) {
            window.history.replaceState({}, document.title, "/staff-chat");
          }
          resetToken = null;
          if (resetViewEl) resetViewEl.hidden = true;
          checkSession();
        })
        .catch(function (err) {
          if (resetSubmitBtn) {
            resetSubmitBtn.disabled = false;
            resetSubmitBtn.textContent = orig;
          }
          if (resetErrorEl) {
            resetErrorEl.textContent = err.message;
            resetErrorEl.hidden = false;
          }
        });
    });
  }

  // ---- Recovery email: a signed-in user sets their own reset address ----
  // Opened via its header tab (see selectSection), which focuses the input
  // when the section becomes visible.

  if (emailForm) {
    emailForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (emailErrorEl) emailErrorEl.hidden = true;
      if (emailNoteEl) emailNoteEl.hidden = true;
      var email = document.getElementById("staff-recovery-email").value.trim();
      fetch("/api/staff/set-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email }),
      })
        .then(jsonResult)
        .then(function (result) {
          if (!result.ok) throw new Error((result.data && result.data.error) || "Couldn't save your email.");
          if (emailNoteEl) {
            emailNoteEl.textContent = "Saved. You can now reset your password by email if you're ever locked out.";
            emailNoteEl.hidden = false;
          }
        })
        .catch(function (err) {
          if (emailErrorEl) {
            emailErrorEl.textContent = err.message;
            emailErrorEl.hidden = false;
          }
        });
    });
  }

  // A reset link (?reset=TOKEN) takes priority over the normal login check.
  if (resetToken) {
    showResetView();
  } else {
    checkSession();
  }
});
