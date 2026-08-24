document.addEventListener("DOMContentLoaded", function () {
  var root = document.querySelector("[data-suburb-index]");
  if (!root) return;

  var input = root.querySelector("[data-suburb-search]");
  var groups = root.querySelectorAll("[data-suburb-group]");
  var empty = root.querySelector("[data-suburb-empty]");
  if (!input) return;

  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    var anyVisible = false;

    groups.forEach(function (group) {
      var items = group.querySelectorAll("[data-suburb-item]");
      var groupHasMatch = false;

      items.forEach(function (item) {
        var match = item.textContent.toLowerCase().indexOf(q) !== -1;
        item.parentElement.hidden = !match;
        if (match) groupHasMatch = true;
      });

      group.hidden = !groupHasMatch;
      if (groupHasMatch) anyVisible = true;
    });

    if (empty) empty.hidden = anyVisible;
  });
});
