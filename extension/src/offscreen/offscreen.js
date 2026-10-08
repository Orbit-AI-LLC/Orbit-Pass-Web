// Copies text for the service worker, which has no document to copy from.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target !== "offscreen" || message.type !== "offscreen-copy") return false;
  const buffer = document.getElementById("buffer");
  buffer.value = message.text;
  buffer.select();
  document.execCommand("copy");
  buffer.value = "";
  reply({ ok: true });
  return false;
});
