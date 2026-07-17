// Deliberately parked at the repo root, not under assets/js/ -- a service
// worker's scope defaults to its own directory, and registering it from root
// avoids needing a Service-Worker-Allowed header just to control /staff-chat.

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {}

  var title = data.title || "New message";
  var options = {
    body: data.body || "",
    icon: "/assets/favicon/android-chrome-192x192.png",
    data: { url: data.url || "/staff-chat" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/staff-chat";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.registration.scope) === 0 && "focus" in client) {
          if ("navigate" in client) client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
