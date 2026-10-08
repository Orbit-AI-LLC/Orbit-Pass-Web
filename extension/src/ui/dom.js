/* Small helpers shared by the popup and the vault page. Everything is built
   with createElement and textContent: nothing from a vault ever goes through
   innerHTML. */

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Static icon markup (ours, never vault data). */
const ICONS = {
  copy: '<path d="M9 9h10v10H9z"/><path d="M5 15V5h10"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.7-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  import: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.2"/><circle cx="15.5" cy="15.5" r="1.2"/><circle cx="15.5" cy="8.5" r="1.2"/><circle cx="8.5" cy="15.5" r="1.2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M4 4v4h4M20 20v-4h-4"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  devices: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6"/><rect x="17" y="8" width="5" height="12" rx="1"/>',
  // Orbit AI's sparkle (aiMark), beside anything Orbit's on-device AI does.
  sparkle: '<path d="M10 3l1.7 4.8 4.8 1.7-4.8 1.7L10 16l-1.7-4.8L3.5 9.5l4.8-1.7z"/><path d="M18 14l.8 2.2 2.2.8-2.2.8L18 20l-.8-2.2-2.2-.8 2.2-.8z"/>',
};

export function icon(name) {
  const span = document.createElement("span");
  span.style.display = "inline-grid";
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  return span;
}

/** Orbit AI's sparkle, filled, in Orbit AI's violet (.ai-mark in orbit.css). */
export function aiMark() {
  const mark = icon("sparkle");
  mark.className = "ai-mark";
  return mark;
}

export function rpc(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (result) => {
      if (chrome.runtime.lastError) return reject(new Error("Orbit Pass isn't responding. Reopen it."));
      if (result && result.error) {
        const error = new Error(result.message || "That didn't work.");
        error.code = result.error;
        if (result.details) error.details = result.details;
        return reject(error);
      }
      resolve(result || {});
    });
  });
}

export function toast(text) {
  document.querySelector(".toast")?.remove();
  const node = h("div", { class: "toast", role: "status" }, text);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 1800);
}

export async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await rpc({ type: "copy", text });
  }
  toast(label);
}

/** A ring that empties as a code's period runs out. */
export function countdownRing(remaining, period) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ring");
  const track = document.createElementNS(svg.namespaceURI, "circle");
  track.setAttribute("cx", "12"); track.setAttribute("cy", "12"); track.setAttribute("r", "9");
  track.setAttribute("fill", "none"); track.setAttribute("stroke", "var(--bg-inset)"); track.setAttribute("stroke-width", "3");
  const arc = document.createElementNS(svg.namespaceURI, "circle");
  arc.setAttribute("cx", "12"); arc.setAttribute("cy", "12"); arc.setAttribute("r", "9");
  arc.setAttribute("fill", "none"); arc.setAttribute("stroke", remaining <= 5 ? "var(--danger)" : "var(--text)"); arc.setAttribute("stroke-width", "3");
  arc.setAttribute("stroke-dasharray", `${(2 * Math.PI * 9 * remaining) / period} 999`);
  arc.setAttribute("transform", "rotate(-90 12 12)");
  svg.append(track, arc);
  return svg;
}

export function initial(text) {
  return (String(text || "?").trim()[0] || "?").toUpperCase();
}

/** Read a QR code from an image (data URL, Blob or file) with the browser's
    own detector. Returns the decoded text or "". */
export async function readQr(source) {
  if (!("BarcodeDetector" in globalThis)) return "";
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const blob = typeof source === "string" ? await (await fetch(source)).blob() : source;
  const bitmap = await createImageBitmap(blob);
  const codes = await detector.detect(bitmap);
  return codes.map((c) => c.rawValue).find((v) => /^(apple-)?otpauth(-migration)?:/i.test(v)) || codes[0]?.rawValue || "";
}
