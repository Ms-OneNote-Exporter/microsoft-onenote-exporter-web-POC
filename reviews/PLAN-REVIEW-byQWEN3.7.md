# PLAN-REVIEW-byQWEN.md

This document provides a critical review of the `PLAN.md` for the `microsoft-onenote-exporter-web` project. The review is structured to highlight critical security flaws, architectural risks, reliability concerns, and actionable improvements.

---

## 1. Critical Security & Architecture Flaws

### 1.1. Credential Proxying via Caddy (High Risk)
**The Plan:** Acknowledges that Caddy will touch the plaintext password bytes as an HTTP proxy before routing to the runner, stating this is "unavoidable unless TLS terminates inside the runner."
**The Flaw:** Relying on a reverse proxy to "not look at" or "not log" plaintext passwords is a fragile security boundary. If Caddy misbuffers, crashes, or if a debug log is accidentally enabled, credentials are exposed in the app-server's memory/disk.
**Improvement:** 
*   **Option A (Recommended):** Terminate TLS inside the Runner's sidecar. Generate a self-signed cert per container, and have Caddy proxy via HTTPS to the runner. 
*   **Option B (Asymmetric Encryption):** The Runner sidecar exposes a public key. The React frontend encrypts the password payload using this key. Caddy and Fastify only ever see ciphertext. Only the Runner can decrypt it. This completely eliminates the "Caddy touches the bytes" risk.

### 1.2. GUID in URL as the Sole Credential (High Risk)
**The Plan:** The session is accessed via `/session/:guid/*`. The GUID is the only credential in v1.
**The Flaw:** URLs are notoriously leaky. The GUID can be exposed via browser history, `Referer` headers (if a user clicks an external link), corporate proxy logs, or browser extensions. If the GUID leaks, the session is fully hijacked.
**Improvement:** 
*   Do not put the GUID in the URL path. Use a generic path like `/session/dashboard`.
*   Store the session identifier in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. 
*   If statelessness is strictly required, at least introduce a lightweight secondary PIN or use a signed, encrypted session token rather than a raw, guessable/leakable GUID.

### 1.3. Host Kernel Dependency for Chromium Sandbox (Operational Risk)
**The Plan:** Relies on `kernel.unprivileged_userns_clone=1` to allow Chromium's sandbox to work without `--no-sandbox`.
**The Flaw:** Modern Linux distributions (e.g., Ubuntu 23.10+, Debian 12+) are actively restricting or disabling unprivileged user namespaces by default due to security vulnerabilities (like CVE-2023-2640). Tying the service's core security model to a host kernel parameter that OS vendors are actively disabling is a ticking time bomb.
**Improvement:** 
*   Pin the host OS to a specific LTS release (e.g., Ubuntu 22.04) where this is still safely configurable.
*   **Fallback:** If user namespaces are unavailable, use `--no-sandbox` for Chromium, but compensate with extreme Docker isolation: `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, run as non-root, and ensure the container has absolutely no network access to the internal Docker bridge or host.

---

## 2. Resource Management & Availability Risks

### 2.1. The 12-Hour Fixed TTL & DDoS Vulnerability (Critical)
**The Plan:** A session lives for a fixed 12 hours. 12 careless users lock out the service for 12 hours. Accepted for v1.
**The Flaw:** This makes the service trivially easy to DDoS. An attacker (or just 12 careless users) can generate 12 GUIDs, authenticate, and close their tabs. The service is dead for 12 hours. For a "one-shot export" tool, 12 hours is an absurdly long time to hold a 1.5GB container.
**Improvement:** 
*   **Do not defer Idle-TTL to v1.1.** Implement a basic activity-based TTL in v1. If the sidecar receives no API calls (e.g., `/status`, `/export`) for 30–60 minutes, it should gracefully shut down and release the slot.
*   Alternatively, implement a "Export Complete" hook that automatically destroys the container 5 minutes after a successful zip download, unless the user explicitly clicks "Keep Session".

### 2.2. Playwright Memory Leaks
**The Plan:** Estimates 1–1.5 GB RSS mid-export.
**The Flaw:** Chromium/Playwright is notorious for memory leaks, especially when processing many pages or handling complex DOMs. A leaky export could push a container past the 2GB `--memory` limit, triggering the OOM Killer and failing the export ungracefully.
**Improvement:** 
*   Implement a memory watchdog in the sidecar. If RSS exceeds 1.8GB, abort the current export, save the partial state, and gracefully restart the sidecar process (or the browser context) to reclaim memory without killing the whole container.

---

## 3. Reliability & Edge Cases

### 3.1. Zip Generation & Disk Space
**The Plan:** "Zip built in-container... Disk-full behaviour: export fails cleanly, partial kept".
**The Flaw:** If the sidecar exports all Markdown/images to disk first, and *then* runs the system `zip` command, it requires 2x the disk space (raw files + zip). A large OneNote notebook will easily hit `ENOSPC`.
**Improvement:** 
*   Do not use the system `zip` binary. Use a Node.js streaming zip library (like `archiver`). 
*   Stream the export directly into the zip archive as it is being generated. This reduces the disk footprint by ~50% and prevents the "run out of disk while zipping" edge case.

### 3.2. SSE Reconnection & Log Fan-out
**The Plan:** Fastify proxies SSE from the Runner to the browser.
**The Flaw:** Mobile networks and unstable connections will drop SSE. When the browser's `EventSource` reconnects, it needs to resume the log stream without duplicating or missing lines.
**Improvement:** 
*   Ensure the Runner's SSE endpoint supports the `Last-Event-ID` header.
*   The Runner sidecar must maintain a circular buffer of the last N log events in memory so it can replay them upon reconnection.

### 3.3. MFA / Number-Matching Brittleness
**The Plan:** Sidecar taps "Accept" in the page for number-matching MFA.
**The Flaw:** Microsoft's login UI changes frequently. Relying on hardcoded Playwright DOM selectors to find the number input fields and the "Accept" button is highly brittle.
**Improvement:** 
*   In `microsoft-webauth`, use robust text-matching or ARIA labels rather than fragile CSS selectors. 
*   Add a fallback: if the sidecar cannot find the UI elements to auto-approve, it should emit a `challenge` event to the frontend asking the user to complete it manually, rather than failing the login outright.

---

## 4. UX & Operational Improvements

### 4.1. "Erase" Semantics
**The Plan:** "Erase" removes the container and deletes the directory. Acknowledges it's not a cryptographic erase.
**Improvement:** Before running `docker rm`, the sidecar should use a secure deletion tool (like `shred -u` or `srm`) on `auth.json`, the exported markdown files, and the zip file. This overwrites the file data on the overlayfs, making casual recovery from the host's disk significantly harder, bridging the gap between "rm -rf" and "LUKS".

### 4.2. Abuse & Rate Limiting
**The Plan:** IP rate limits, no captcha.
**Improvement:** IP rate limiting is easily bypassed with residential proxies. Since the service processes Microsoft logins, it could be used to test stolen credentials (Credential Stuffing). 
*   Integrate a privacy-preserving challenge like **Cloudflare Turnstile** on the initial GUID generation and the Microsoft Login form. It requires no user interaction (no captcha) but stops automated botnets.

### 4.3. Frontend State Management
**The Plan:** React frontend, blocks greyed out until `auth.json` exists.
**Improvement:** Ensure the frontend polls `/status` on mount. If a user refreshes the page mid-export, the frontend should immediately reconnect to the SSE stream and restore the UI state (e.g., showing the progress bar and live logs) without requiring the user to restart the export.

---

## Summary of Recommendations for v1

1.  **Drop the 12-hour fixed TTL.** Implement a 30-minute Idle-TTL or auto-destroy on export completion. The DDoS risk is too high.
2.  **Move credentials out of the URL.** Use `HttpOnly` cookies for session management.
3.  **Stream the Zip.** Use `archiver` to prevent disk exhaustion during large exports.
4.  **Encrypt credentials in transit.** Use Runner-side TLS or RSA encryption so Caddy never sees plaintext passwords.
5.  **Pin the Host OS.** If relying on unprivileged user namespaces, explicitly mandate Ubuntu 22.04 LTS in the deployment docs, as newer OSs will break the Chromium sandbox.