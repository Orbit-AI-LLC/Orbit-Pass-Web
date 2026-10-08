/* Website icons in the popup and the vault page (lib/icons.js says where they
   come from). An item's square draws at once: its site's icon when this page
   has it, else its first letter, which the icon replaces when it arrives.
   loadSiteIcons asks the vault service, which answers from this device's copy
   and then the server, a batch at a time, while the server fetches sites it
   hasn't seen. */

import { iconDomain } from "../lib/icons.js";
import { h, initial, rpc } from "./dom.js";

// This page's copy: site -> data URL, or null for a site with no icon.
const known = new Map();
const asking = new Set();

/** The square beside an item: its site's icon, else its first letter. */
export function itemAvatar(item, title) {
  const site = iconDomain(item);
  const letter = initial(title);
  const box = h("span", { class: "avatar", dataset: site ? { site, letter } : null }, letter);
  if (site && known.get(site)) show(box, known.get(site));
  return box;
}

function show(box, url) {
  const img = h("img", { src: url, alt: "", draggable: "false" });
  // A picture the browser can't draw: back to the letter.
  img.addEventListener("error", () => { box.classList.remove("site"); box.replaceChildren(box.dataset.letter); }, { once: true });
  box.classList.add("site");
  box.replaceChildren(img);
}

function paint() {
  for (const box of document.querySelectorAll(".avatar[data-site]:not(.site)")) {
    const url = known.get(box.dataset.site);
    if (url) show(box, url);
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetch the icons of these items' sites that this page doesn't have yet,
    and put each in place as it comes. */
export async function loadSiteIcons(items) {
  const wanted = [...new Set(items.map(iconDomain).filter((site) => site && !known.has(site) && !asking.has(site)))];
  if (!wanted.length) return;
  for (const site of wanted) asking.add(site);
  let sites = wanted;
  let waits = 0;
  try {
    while (sites.length) {
      const { icons = {}, missing = [] } = await rpc({ type: "site-icons", domains: sites });
      for (const [site, url] of Object.entries(icons)) known.set(site, url);
      paint();
      // Nothing new: the server is still fetching these, or can't be reached.
      // Ask again a little later, a few times.
      if (missing.length >= sites.length) {
        if (++waits > 3) break;
        await pause(3000 * waits);
      }
      sites = missing;
    }
  } catch {
    // The letters stay.
  } finally {
    for (const site of wanted) asking.delete(site);
  }
}

/** Icons turned off: every square goes back to its letter. */
export function clearSiteIcons() {
  known.clear();
  for (const box of document.querySelectorAll(".avatar.site[data-site]")) {
    box.classList.remove("site");
    box.replaceChildren(box.dataset.letter);
  }
}
