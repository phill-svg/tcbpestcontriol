// Deliberately parked at the repo root, not under assets/js/ -- a service
// worker's scope defaults to its own directory, and registering it from root
// avoids needing a Service-Worker-Allowed header just to control /staff-chat.

// Take over as soon as a new version lands instead of waiting for every tab to
// close. Without this a push fix can sit unused on a phone for weeks, because
// an installed iOS web app is rarely fully closed.
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

function urlBase64ToUint8Array(base64String) {
  var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var rawData = self.atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {}

  var title = data.title || "New message";
  var options = {
    body: data.body || "",
    icon: "/assets/favicon/android-chrome-192x192.png",
    badge: "/assets/favicon/favicon-32x32.png",
    data: { url: data.url || "/staff-chat" },
  };

  // iOS revokes the push subscription outright if a push ever arrives without
  // a notification being shown, so this must never become conditional.
  event.waitUntil(self.registration.showNotification(title, options));
});

// Safari/iOS can rotate or drop a push subscription while nothing is open (OS
// updates, storage eviction, a long gap between launches). When the browser
// tells us it happened, resubscribe and hand the new endpoint to the server --
// otherwise the device silently stops receiving anything.
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    fetch("/api/push/vapid-public-key")
      .then(function (res) {
        return res.text();
      })
      .then(function (publicKey) {
        if (!publicKey) throw new Error("no VAPID public key configured");
        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey.trim()),
        });
      })
      .then(function (subscription) {
        return fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subscription.toJSON()),
        });
      })
      .catch(function (err) {
        // Nothing useful to do from here -- the dashboard re-syncs the
        // subscription on its next load, which is the real safety net.
        self.console && console.error("pushsubscriptionchange failed", err);
      })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/staff-chat";

  // Lead notifications point at the ServiceM8 job, which is another origin --
  // client.navigate() only accepts same-origin URLs, so reusing an open tab is
  // only an option for our own pages. Anything external gets a new window.
  var isOurs = url.indexOf("/") === 0 || url.indexOf(self.registration.scope) === 0;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      if (isOurs) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if (client.url.indexOf(self.registration.scope) === 0 && "focus" in client) {
            if ("navigate" in client) client.navigate(url);
            return client.focus();
          }
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
