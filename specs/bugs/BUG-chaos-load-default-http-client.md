# Chaos load key-package polling uses the browser default HTTP client

## Reproduce

Environment: macOS, Node chaos-load process, local PostgreSQL, Docker disabled. After correcting initial server-owner group creation, run the 3-user/1-channel chaos smoke.

The legacy group is created and peers join, then `waitForKeyPackages` throws `TypeError: localStorage.getItem is not a function` from `BrowserSessionStore.getServerUrl` while calling `getMyKeyPackageCount`.

## Isolate

`waitForKeyPackages` invokes `getMyKeyPackageCount(deviceId)` inside the device storage context but does not pass `device.httpClient`. Storage context does not select an HTTP session. The API helper therefore uses its browser-oriented default client, which reads global `localStorage`; Node's local-storage shim is not a valid browser storage object in this process.

## Hypothesize

1. **Primary: the load script omits the explicit per-device HTTP client.**
   - Prediction: the stack reaches `BrowserSessionStore` despite the device harness already owning an authenticated `httpClient`.
   - Falsification: the helper receives `device.httpClient` and still enters the browser default store.
2. **The device session was lost during group bootstrap.**
   - Prediction: the explicit device HTTP client returns an authentication error.
   - Falsification: other authenticated device requests and socket joins already succeeded.
3. **Async storage context fails to propagate.**
   - Prediction: crypto database calls use the wrong user context.
   - Falsification: the stack fails before storage access, while resolving the default HTTP server URL.

## Verify

Confirmed root cause: a boundary dependency was implicit. `getMyKeyPackageCount` accepts an HTTP client but the load script omitted it, causing a Node process to instantiate the browser default session path. The device harness already owns the exact authenticated client required by the request.

The fix is to pass `device.httpClient` explicitly. HTTP ownership and crypto-storage ownership are separate contexts and must not be inferred from one another.
