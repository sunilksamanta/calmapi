// Applies the saved theme before first paint so dark mode never flashes white.
// A classic script on purpose: modules are deferred and would run too late.
try {
  const theme = JSON.parse(localStorage.getItem('calm-devtools:theme'));
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be unavailable (private windows, blocked site data). Fall back to the system theme.
}
