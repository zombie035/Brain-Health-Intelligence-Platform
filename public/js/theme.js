/* BrainGuard AI theme: nav state, mobile menu, scroll reveal. Presentation only. */
(function () {
  var nav = document.getElementById("siteNav");
  if (nav) {
    var toggle = nav.querySelector(".nav-toggle");
    var path = location.pathname.replace(/\/+$/, "") || "/";
    nav.querySelectorAll("nav a").forEach(function (a) {
      var p = (a.getAttribute("href") || "").replace(/\/+$/, "") || "/";
      if (p === path || (p !== "/" && path.indexOf(p) === 0)) a.setAttribute("aria-current", "page");
    });
    if (toggle) toggle.addEventListener("click", function () {
      toggle.setAttribute("aria-expanded", String(nav.classList.toggle("nav-open")));
    });
    var onScroll = function () { nav.classList.toggle("is-scrolled", window.scrollY > 8); };
    onScroll(); window.addEventListener("scroll", onScroll, { passive: true });
  }
  var items = document.querySelectorAll(".card,.stat-card,.feature-box,.summary-card,.eye-test-card,.history-table-container,.page-heading");
  var targets = Array.prototype.filter.call(items, function (el) { return !el.closest(".eye-test-runner"); });
  if (!("IntersectionObserver" in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  targets.forEach(function (el, i) { el.classList.add("reveal"); el.style.transitionDelay = (i % 3) * 70 + "ms"; io.observe(el); });
})();
