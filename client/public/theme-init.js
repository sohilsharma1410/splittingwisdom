// Runs before first paint so dark-mode users never see a flash of the light
// theme. Kept as a separate file (not inline) so a strict Content-Security-
// Policy can keep forbidding inline scripts. Must match use-theme.tsx.
(function () {
  try {
    var stored = window.localStorage.getItem("splittingwisdom-theme");
    var dark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (dark) {
      document.documentElement.classList.add("dark");
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", "#131c24");
    }
  } catch (e) {
    // Storage blocked: fall through to the light theme; the app corrects it once loaded.
  }
})();
