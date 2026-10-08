// The link page sent the browser here with the sign-in code in the query and
// the vault key, wrapped to this extension, in the fragment. Hand both to the
// service worker and wipe them from the address bar and history at once.
const search = location.search;
const hash = location.hash;
history.replaceState(null, "", location.pathname);

const title = document.getElementById("title");
const detail = document.getElementById("detail");

chrome.runtime.sendMessage({ type: "auth-callback", search, hash }, (result) => {
  if (chrome.runtime.lastError || !result) {
    title.textContent = "Signing in didn't finish";
    detail.textContent = "Close this tab and try again from Orbit Pass.";
    return;
  }
  if (result.retry) {
    title.textContent = "One more step";
    detail.textContent = "Orbit needs your password once to open your vault on this device.";
    return;
  }
  if (result.error) {
    title.textContent = result.error === "needs-previous" ? "Your Orbit password changed" : "Signing in didn't finish";
    detail.textContent = result.error === "needs-previous"
      ? "Open Orbit Pass from the toolbar and enter your previous Orbit password once to move your vault over."
      : result.message;
    return;
  }
  title.textContent = "You're signed in";
  detail.textContent = "Orbit Pass is unlocked. This tab closes by itself.";
});
