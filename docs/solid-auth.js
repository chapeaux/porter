/**
 * solid-auth.js -- Solid OIDC authentication for Porter Station
 *
 * Self-contained: UUID, Base64URL, DPoP (RFC 9449), OIDC discovery,
 * dynamic client registration, PKCE login, token exchange, authenticated
 * fetch with DPoP proofs, and Pod storage discovery.
 *
 * Exposes window.solidAuth with the public API.
 */
(function () {
  "use strict";

  // ── Storage key constants ──────────────────────────────────────────
  var SESSION_KEY      = "porter-solid-auth";
  var CLIENT_KEY       = "porter-solid-client";
  var LAST_IDP_KEY     = "porter-solid-last-idp";
  var STATE_KEY        = "porter-solid-state";
  var VERIFIER_KEY     = "porter-solid-verifier";
  var PENDING_KEY      = "porter-solid-pending";

  var CLIENT_NAME = "Porter Station";

  var currentSession = null;
  var podStorageCache = {};

  // ── UUID v4 ────────────────────────────────────────────────────────

  /**
   * Generate a UUID v4 using crypto.getRandomValues.
   * Works in both secure (HTTPS) and insecure (HTTP) contexts,
   * unlike crypto.randomUUID() which requires a secure context.
   * @returns {string}
   */
  function uuid() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    var hex = [];
    for (var i = 0; i < bytes.length; i++) {
      hex.push(bytes[i].toString(16).padStart(2, "0"));
    }
    var h = hex.join("");
    return (
      h.slice(0, 8) + "-" +
      h.slice(8, 12) + "-" +
      h.slice(12, 16) + "-" +
      h.slice(16, 20) + "-" +
      h.slice(20)
    );
  }

  // ── Base64 URL helpers ─────────────────────────────────────────────

  /**
   * Base64 URL encode bytes or a string.
   * @param {Uint8Array|string} input
   * @returns {string}
   */
  function base64UrlEncode(input) {
    var bytes = input instanceof Uint8Array
      ? input
      : new TextEncoder().encode(input);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /**
   * Base64 URL decode to string.
   * @param {string} str
   * @returns {string}
   */
  function base64UrlDecode(str) {
    var padded = str + "=".repeat((4 - (str.length % 4)) % 4);
    var binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  // ── DPoP (RFC 9449) ───────────────────────────────────────────────

  /**
   * Generate an ES256 key pair for DPoP.
   * @returns {Promise<{privateKey: CryptoKey, publicKey: CryptoKey, publicJwk: object}>}
   */
  async function generateDpopKeyPair() {
    var keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    var publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    delete publicJwk.d;
    delete publicJwk.key_ops;
    delete publicJwk.ext;
    return {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      publicJwk: publicJwk
    };
  }

  /**
   * Sign a JWT with ES256.
   * @param {object} header
   * @param {object} claims
   * @param {CryptoKey} privateKey
   * @returns {Promise<string>}
   */
  async function signJwt(header, claims, privateKey) {
    var encoder = new TextEncoder();
    var headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
    var claimsB64 = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
    var signingInput = headerB64 + "." + claimsB64;
    var signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      encoder.encode(signingInput)
    );
    var sigB64 = base64UrlEncode(new Uint8Array(signature));
    return signingInput + "." + sigB64;
  }

  /**
   * Create a DPoP proof JWT (RFC 9449).
   * @param {CryptoKey} privateKey
   * @param {object} publicJwk
   * @param {string} method - HTTP method
   * @param {string} url - Target URL (without query/fragment)
   * @param {string} [accessToken] - Optional; adds ath claim
   * @returns {Promise<string>}
   */
  async function createDpopProof(privateKey, publicJwk, method, url, accessToken) {
    var header = {
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: publicJwk
    };
    var claims = {
      htm: method,
      htu: url,
      iat: Math.floor(Date.now() / 1000),
      jti: uuid()
    };
    if (accessToken) {
      var encoder = new TextEncoder();
      var hash = await crypto.subtle.digest("SHA-256", encoder.encode(accessToken));
      claims.ath = base64UrlEncode(new Uint8Array(hash));
    }
    return signJwt(header, claims, privateKey);
  }

  /**
   * Decode a JWT without verification (for reading claims).
   * @param {string} jwt
   * @returns {{header: object, claims: object}}
   */
  function decodeJwt(jwt) {
    var parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT format");
    return {
      header: JSON.parse(base64UrlDecode(parts[0])),
      claims: JSON.parse(base64UrlDecode(parts[1]))
    };
  }

  // ── OIDC Discovery & Dynamic Registration ─────────────────────────

  /**
   * Fetch OIDC configuration from a Solid identity provider.
   * @param {string} issuer
   * @returns {Promise<object>}
   */
  async function discoverOIDC(issuer) {
    var url = issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
    var response = await fetch(url);
    if (!response.ok) throw new Error("OIDC discovery failed: " + response.status);
    return response.json();
  }

  /**
   * Register a dynamic client with the OIDC provider.
   * @param {string} registrationEndpoint
   * @param {string} clientName
   * @param {string[]} redirectUris
   * @param {object} [metadata]
   * @returns {Promise<{client_id: string}>}
   */
  async function registerClient(registrationEndpoint, clientName, redirectUris, metadata) {
    var body = {
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web"
    };
    if (metadata) {
      var keys = Object.keys(metadata);
      for (var i = 0; i < keys.length; i++) {
        body[keys[i]] = metadata[keys[i]];
      }
    }
    var response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error("Client registration failed: " + response.status);
    return response.json();
  }

  // ── Auth Flow ─────────────────────────────────────────────────────

  /**
   * Return current session info.
   * @returns {{isLoggedIn: boolean, webId: string|null}}
   */
  function getSessionInfo() {
    if (currentSession) {
      return { isLoggedIn: true, webId: currentSession.webId };
    }
    return { isLoggedIn: false, webId: null };
  }

  /**
   * Initiate Solid OIDC login.
   * Discovers the IdP, registers a dynamic client (or uses cache),
   * generates PKCE + DPoP keys, then redirects the browser.
   *
   * @param {string} issuer - IdP URL (e.g. "https://login.inrupt.com")
   * @param {string} redirectUrl - Where to come back after auth
   */
  async function solidLogin(issuer, redirectUrl) {
    var config = await discoverOIDC(issuer);

    var appOrigin = new URL(redirectUrl).origin;

    // Try cached client registration
    var clientCacheKey = CLIENT_KEY + ":" + issuer;
    var client;
    try {
      var cached = localStorage.getItem(clientCacheKey);
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed._redirectUrl === redirectUrl) {
          client = parsed;
        } else {
          localStorage.removeItem(clientCacheKey);
        }
      }
    } catch (_) { /* ignore */ }

    if (!client || !client.client_id) {
      client = await registerClient(
        config.registration_endpoint,
        CLIENT_NAME,
        [redirectUrl],
        {
          client_uri: appOrigin,
          scope: "openid webid profile offline_access"
        }
      );
      client._redirectUrl = redirectUrl;
      localStorage.setItem(clientCacheKey, JSON.stringify(client));
    }

    // PKCE: code verifier + challenge
    var verifier = uuid() + uuid();
    var encoder = new TextEncoder();
    var hash = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
    var challenge = base64UrlEncode(new Uint8Array(hash));

    // DPoP key pair
    var keys = await generateDpopKeyPair();
    var privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);

    var state = uuid().replace(/-/g, "");

    // Persist pending auth state in sessionStorage
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      issuer: issuer,
      state: state,
      verifier: verifier,
      clientId: client.client_id,
      redirectUrl: redirectUrl,
      tokenEndpoint: config.token_endpoint,
      endSessionEndpoint: config.end_session_endpoint || null,
      dpopPrivateJwk: privateJwk,
      dpopPublicJwk: keys.publicJwk
    }));

    // Also store state and verifier under their own keys for clarity
    localStorage.setItem(STATE_KEY, state);
    localStorage.setItem(VERIFIER_KEY, verifier);

    // Build authorization URL
    var authUrl = new URL(config.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUrl);
    authUrl.searchParams.set("scope", "openid webid profile offline_access");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    window.location.href = authUrl.toString();
  }

  /**
   * Handle the OIDC redirect callback.
   * Exchanges the authorization code for tokens, extracts the WebID,
   * and persists the session.
   *
   * @returns {Promise<{isLoggedIn: boolean, webId: string|null}>}
   */
  async function handleRedirect() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    var state = params.get("state");

    if (!code || !state) {
      return restoreSession();
    }

    // Clean the URL bar
    var cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, "", cleanUrl);

    var storedStr = localStorage.getItem(PENDING_KEY);
    if (!storedStr) {
      return restoreSession();
    }

    var stored = JSON.parse(storedStr);
    if (stored.state !== state) {
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(VERIFIER_KEY);
      return restoreSession();
    }

    try {
      var privateKey = await crypto.subtle.importKey(
        "jwk",
        stored.dpopPrivateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"]
      );

      var tokenResponse = await fetch(stored.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: stored.redirectUrl,
          client_id: stored.clientId,
          code_verifier: stored.verifier
        })
      });

      if (!tokenResponse.ok) {
        // Clear stale client cache on failure
        localStorage.removeItem(PENDING_KEY);
        localStorage.removeItem(STATE_KEY);
        localStorage.removeItem(VERIFIER_KEY);
        var storageKeys = Object.keys(localStorage);
        for (var i = 0; i < storageKeys.length; i++) {
          if (storageKeys[i].indexOf(CLIENT_KEY) === 0) {
            localStorage.removeItem(storageKeys[i]);
          }
        }
        return restoreSession();
      }

      var tokens = await tokenResponse.json();
      var decoded = decodeJwt(tokens.id_token);
      var webId = decoded.claims.webid || decoded.claims.sub;
      var tokenType = tokens.token_type || "Bearer";

      currentSession = {
        webId: webId,
        accessToken: tokens.access_token,
        tokenType: tokenType,
        idToken: tokens.id_token,
        refreshToken: tokens.refresh_token || null,
        expiresIn: tokens.expires_in || null,
        tokenEndpoint: stored.tokenEndpoint,
        endSessionEndpoint: stored.endSessionEndpoint,
        clientId: stored.clientId,
        issuer: stored.issuer,
        dpopPrivateJwk: stored.dpopPrivateJwk,
        dpopPublicJwk: stored.dpopPublicJwk
      };

      localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
      localStorage.setItem(LAST_IDP_KEY, stored.issuer);
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(VERIFIER_KEY);

      scheduleProactiveRefresh();
      return { isLoggedIn: true, webId: webId };
    } catch (err) {
      console.error("[porter-solid-auth] Token exchange error:", err);
      return { isLoggedIn: false, webId: null };
    }
  }

  /**
   * Restore a session from localStorage.
   * @returns {{isLoggedIn: boolean, webId: string|null}}
   */
  function restoreSession() {
    var stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return { isLoggedIn: false, webId: null };

    try {
      currentSession = JSON.parse(stored);
      scheduleProactiveRefresh();
      return { isLoggedIn: true, webId: currentSession.webId };
    } catch (_) {
      localStorage.removeItem(SESSION_KEY);
      return { isLoggedIn: false, webId: null };
    }
  }

  /**
   * Clear all session data and log out.
   */
  function solidLogoutUser() {
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(VERIFIER_KEY);
    currentSession = null;
    podStorageCache = {};
  }

  // ── Proactive Token Refresh ──────────────────────────────────────

  var _refreshTimer = null;

  function scheduleProactiveRefresh() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    if (!currentSession || !currentSession.refreshToken) return;
    var ttl = (currentSession.expiresIn || 600) * 1000;
    var interval = ttl - 60000;
    if (interval < 30000) interval = 30000;
    _refreshTimer = setTimeout(async function() {
      _refreshTimer = null;
      var ok = await refreshAccessToken();
      if (ok) {
        scheduleProactiveRefresh();
        window.dispatchEvent(new CustomEvent('porter-auth-refreshed'));
      } else {
        window.dispatchEvent(new CustomEvent('porter-auth-expired'));
      }
    }, interval);
  }

  // ── Token Refresh ─────────────────────────────────────────────────

  async function refreshAccessToken() {
    if (!currentSession || !currentSession.refreshToken || !currentSession.tokenEndpoint) {
      return false;
    }
    try {
      var body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: currentSession.refreshToken,
        client_id: currentSession.clientId
      });

      var headers = { "Content-Type": "application/x-www-form-urlencoded" };

      if (currentSession.tokenType === "DPoP" && currentSession.dpopPrivateJwk) {
        var privateKey = await crypto.subtle.importKey(
          "jwk", currentSession.dpopPrivateJwk,
          { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
        );
        var dpopProof = await createDpopProof(
          privateKey, currentSession.dpopPublicJwk,
          "POST", currentSession.tokenEndpoint.split("?")[0]
        );
        headers["DPoP"] = dpopProof;
      }

      var resp = await fetch(currentSession.tokenEndpoint, {
        method: "POST", headers: headers, body: body.toString()
      });
      if (!resp.ok) return false;

      var tokens = await resp.json();
      currentSession.accessToken = tokens.access_token;
      if (tokens.refresh_token) currentSession.refreshToken = tokens.refresh_token;
      if (tokens.expires_in) currentSession.expiresIn = tokens.expires_in;
      localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
      console.log("[porter-solid-auth] Token refreshed");
      return true;
    } catch (err) {
      console.error("[porter-solid-auth] Token refresh failed:", err);
      return false;
    }
  }

  function getAuthFetch() {
    var refreshing = null;

    return async function authFetch(url, options, _isRetry) {
      if (!currentSession) return fetch(url, options);

      options = options || {};
      var method = (options.method || "GET").toUpperCase();
      var rawUrl = typeof url === "string" ? url : url.toString();
      var headers = new Headers(options.headers || {});

      if (currentSession.tokenType === "DPoP" && currentSession.dpopPrivateJwk) {
        try {
          var targetUrl = rawUrl.split("?")[0].split("#")[0];
          var privateKey = await crypto.subtle.importKey(
            "jwk",
            currentSession.dpopPrivateJwk,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign"]
          );
          var dpopProof = await createDpopProof(
            privateKey,
            currentSession.dpopPublicJwk,
            method,
            targetUrl,
            currentSession.accessToken
          );
          headers.set("Authorization", "DPoP " + currentSession.accessToken);
          headers.set("DPoP", dpopProof);
        } catch (err) {
          console.error("[porter-solid-auth] DPoP proof failed, falling back to Bearer:", err);
          headers.set("Authorization", "Bearer " + currentSession.accessToken);
        }
      } else {
        headers.set("Authorization", "Bearer " + currentSession.accessToken);
      }

      var resp = await fetch(url, Object.assign({}, options, { headers: headers }));

      if (resp.status === 401 && !_isRetry) {
        if (currentSession.refreshToken) {
          if (!refreshing) refreshing = refreshAccessToken().finally(function() { refreshing = null; });
          var refreshed = await refreshing;
          if (refreshed) return authFetch(url, options, true);
        }
        // Refresh failed or no refresh token — session is dead
        console.error("[porter-solid-auth] Session expired, clearing");
        solidLogoutUser();
        window.dispatchEvent(new CustomEvent("porter-auth-expired"));
      }

      return resp;
    };
  }

  // ── Pod Storage Discovery ─────────────────────────────────────────

  /**
   * Discover Pod storage URL from a WebID profile document.
   * Fetches the WebID as Turtle, parses for pim:storage or
   * solid:storageRoot triples.
   *
   * @param {string} webId - The WebID URL
   * @returns {Promise<string|null>} Storage URL or null
   */
  async function discoverPodStorage(webId) {
    if (podStorageCache[webId]) return podStorageCache[webId];

    try {
      var fetchFn = getAuthFetch();
      var response = await fetchFn(webId, {
        headers: { "Accept": "text/turtle" }
      });

      if (!response.ok) {
        console.error("[porter-solid-auth] Failed to fetch WebID profile:", response.status);
        return null;
      }

      var turtle = await response.text();

      // Match pim:storage or space:storage or solid:storageRoot
      // Handles both prefixed and full-URI forms:
      //   <#me> <http://www.w3.org/ns/pim/space#storage> <https://pod.example/> .
      //   <#me> pim:storage <https://pod.example/> .
      //   <#me> solid:storageRoot <https://pod.example/> .
      var patterns = [
        /(?:pim:storage|space:storage|<http:\/\/www\.w3\.org\/ns\/pim\/space#storage>)\s+<([^>]+)>/,
        /(?:solid:storageRoot|<http:\/\/www\.w3\.org\/ns\/solid\/terms#storageRoot>)\s+<([^>]+)>/
      ];

      for (var i = 0; i < patterns.length; i++) {
        var match = turtle.match(patterns[i]);
        if (match && match[1]) {
          podStorageCache[webId] = match[1];
          return match[1];
        }
      }

      return null;
    } catch (err) {
      console.error("[porter-solid-auth] Pod storage discovery error:", err);
      return null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  window.solidAuth = {
    solidLogin: solidLogin,
    handleRedirect: handleRedirect,
    restoreSession: restoreSession,
    getSessionInfo: getSessionInfo,
    solidLogoutUser: solidLogoutUser,
    getAuthFetch: getAuthFetch,
    discoverPodStorage: discoverPodStorage
  };
})();
