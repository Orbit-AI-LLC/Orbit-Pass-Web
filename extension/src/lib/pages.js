/* What the vault and popup pages can ask for, shared by the Chrome
   extension's service worker and the Windows app's page. Each host says how
   it opens a sign-in address, copies text and names itself (`platform`); the
   rest is the same VaultService either way.

   Returns undefined for a message it doesn't know, so a host can handle its
   own (the extension's "fill this tab", say) before answering "unknown". */

import { generatePassword } from "./generator.js";
import { parseOtpauthLoose } from "./items.js";
import { totp } from "./totp.js";

export async function codeFor(item) {
  const config = parseOtpauthLoose(item?.login?.totp);
  return config ? totp(config) : null;
}

/**
 * @param {object} message
 * @param {object} host
 * @param {import("./vault.js").VaultService} host.vault
 * @param {import("./store.js").Area} host.local
 * @param {object} host.platform  {name, client: {returnTo, device, extensionId}, openUrl(url), copy(text)}
 */
export async function handlePageMessage(message, { vault, local, platform }) {
  switch (message.type) {
    case "status": return { ...(await vault.status()), platform: platform.name };
    case "settings": return vault.settings();
    case "update-settings": return vault.updateSettings(message.changes || {});
    case "set-server": await vault.setServer(message.server); return { ...(await vault.status()), platform: platform.name };
    case "sign-in":
    case "unlock-orbit": {
      const url = await vault.beginSignIn({ intent: message.type === "sign-in" ? "link" : "unlock", ...platform.client });
      await platform.openUrl(url);
      return {};
    }
    case "auth-callback": {
      const result = await vault.completeSignIn({ search: message.search, hash: message.hash });
      return result.retry ? { retry: result.retry } : { done: true };
    }
    case "unlock-password": await vault.unlockWithPassword(message.password); return vault.status();
    case "previous-password": await vault.providePreviousPassword(message.password); return vault.status();
    case "start-over": await vault.startOver(); return vault.status();
    case "lock": await vault.lock(); return vault.status();
    case "sign-out": await vault.signOut(); return vault.status();
    case "sync": await vault.sync(); return {};
    case "entries": await vault.touch(); return { entries: await vault.entries() };
    case "vaults": return { vaults: await vault.vaults(), me: (await local.get("account"))?.user || null };
    case "save-item": return { id: await vault.saveItem(message.entry) };
    case "delete-item": await vault.deleteItem(message.id); return {};
    case "move-item": return { id: await vault.moveItem(message.id, message.vault) };
    case "import-items": return vault.importItems(message.vault, message.items);
    case "reconcile-fields": return vault.reconcileFields(message.vaults, message.options);
    case "create-vault": return { id: await vault.createSharedVault(message.name, message.description) };
    case "rename-vault": await vault.renameVault(message.id, message.name, message.description); return {};
    case "delete-vault": await vault.deleteVault(message.id); return {};
    case "leave-vault": await vault.leaveVault(message.id); return {};
    case "candidates": return { people: await vault.candidates(message.id, message.q) };
    case "add-member": await vault.addMember(message.id, message.person, message.role); return {};
    case "set-role": await vault.setRole(message.id, message.userId, message.role); return {};
    case "remove-member": await vault.removeMember(message.id, message.userId); return {};
    case "reshare": await vault.reshare(message.id, message.member); return {};
    case "rotate-vault": await vault.rotateVault(message.id); return {};
    case "site-icons": return vault.siteIcons(message.domains, { ask: message.ask !== false });
    case "devices": return { devices: await vault.devices() };
    case "sign-out-device": await vault.signOutDevice(message.keyId); return {};
    case "totp": {
      const entry = await vault.entry(message.id);
      return entry ? { code: await codeFor(entry.item) } : {};
    }
    case "copy": await platform.copy(String(message.text || "")); return {};
    case "generate": return { password: generatePassword(message.options || {}) };
    default: return undefined;
  }
}
