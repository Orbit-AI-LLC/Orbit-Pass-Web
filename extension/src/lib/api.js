/* The Orbit Pass server API (README, "API"). Every call carries the device
   token; the server answers {error, message} on a refusal, and the message
   is written for people, so it is shown as is. */

export class ApiError extends Error {
  constructor(status, code, message, body = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class Api {
  constructor(server, token) {
    this.server = String(server || "").replace(/\/+$/, "");
    this.token = token;
  }

  async call(method, path, body) {
    let response;
    try {
      response = await fetch(`${this.server}/api/v1/${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "offline", "Orbit Pass can't reach its server. Check your connection.");
    }
    if (response.status === 204) return {};
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const message = data.message || (response.status >= 500 ? "Something went wrong on our side. Try again in a moment." : "That didn't work. Try again.");
      throw new ApiError(response.status, data.error || "error", message, data);
    }
    return data;
  }

  exchange(code, verifier, device) { return this.call("POST", "link/exchange", { code, verifier, device }); }
  me() { return this.call("GET", "me"); }
  registerIdentity(identity, envelopes = []) { return this.call("POST", "identity", { ecdh: identity.ecdh, sign: identity.sign, envelopes }); }
  sync(since = 0) { return this.call("GET", `sync?since=${since}`); }
  createVault(body) { return this.call("POST", "vaults", body); }
  updateVault(id, meta) { return this.call("PATCH", `vaults/${id}`, { meta }); }
  deleteVault(id) { return this.call("DELETE", `vaults/${id}`); }
  candidates(id, q = "") { return this.call("GET", `vaults/${id}/candidates?q=${encodeURIComponent(q)}`); }
  putMember(id, userId, body) { return this.call("PUT", `vaults/${id}/members/${userId}`, body); }
  removeMember(id, userId) { return this.call("DELETE", `vaults/${id}/members/${userId}`); }
  rotate(id, body) { return this.call("POST", `vaults/${id}/rotate`, body); }
  createItem(body) { return this.call("POST", "items", body); }
  updateItem(id, body) { return this.call("PUT", `items/${id}`, body); }
  deleteItem(id, revision) { return this.call("DELETE", `items/${id}`, { revision }); }
  siteIcons(domains) { return this.call("POST", "icons", { domains }); }
  devices() { return this.call("GET", "devices"); }
  signOutDevice(keyId) { return this.call("DELETE", `devices/${keyId}`); }
}
