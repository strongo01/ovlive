// OVLive browser-scoped fair-use identifier for public API rate limits.
// This is a pseudonymous identifier, not login/authentication and not a hardware ID.
(() => {
  "use strict";

  const storageKey = "ovlive-device-id-v1";
  const headerName = "x-ovlive-device-id";
  const validId = /^[a-f0-9]{32}$/i;

  function createId() {
    const bytes = new Uint8Array(16);
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        window.crypto.getRandomValues(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += 1) {
          bytes[i] = Math.floor(Math.random() * 256);
        }
      }
    } catch {
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function readOrCreate(storage) {
    try {
      const existing = storage.getItem(storageKey);
      if (existing && validId.test(existing)) return existing;
      const created = createId();
      storage.setItem(storageKey, created);
      const saved = storage.getItem(storageKey);
      return saved && validId.test(saved) ? saved : created;
    } catch {
      return null;
    }
  }

  let deviceId = null;
  try {
    deviceId = readOrCreate(window.localStorage);
  } catch {
    // Some privacy modes deny even access to the storage object.
  }
  if (!deviceId) {
    try {
      deviceId = readOrCreate(window.sessionStorage);
    } catch {
      // The in-memory fallback below keeps the app usable without storage.
    }
  }
  if (!deviceId) deviceId = createId();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function ovliveRateLimitedFetch(input, init) {
    let rawUrl;
    try {
      if (typeof input === "string" || input instanceof URL) {
        rawUrl = String(input);
      } else if (input instanceof Request) {
        rawUrl = input.url;
      } else {
        return nativeFetch(input, init);
      }

      const url = new URL(rawUrl, window.location.href);
      if (url.origin !== window.location.origin ||
          !url.pathname.startsWith("/api/")) {
        return nativeFetch(input, init);
      }

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init && init.headers) {
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      }
      if (!headers.has(headerName)) headers.set(headerName, deviceId);
      return nativeFetch(input, { ...(init || {}), headers });
    } catch {
      // Do not break ordinary network requests if browser storage/header setup fails.
      return nativeFetch(input, init);
    }
  };
})();
