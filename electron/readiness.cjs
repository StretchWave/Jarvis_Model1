/**
 * JARVIS Server Readiness Check
 * 
 * Performs active HTTP health polling rather than fragile hardcoded delays.
 */

const http = require("node:http");

/**
 * Polls statusUrl until HTTP 200 is returned or timeout is reached.
 * @param {string} statusUrl - e.g. "http://127.0.0.1:31415/api/status"
 * @param {number} timeoutMs - Maximum wait time in milliseconds
 * @param {number} intervalMs - Polling interval in milliseconds
 * @returns {Promise<boolean>}
 */
function waitForServerReady(statusUrl, timeoutMs = 15000, intervalMs = 250) {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      const req = http.get(statusUrl, { timeout: 1500 }, (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else if (Date.now() - startTime >= timeoutMs) {
          reject(new Error(`Server at ${statusUrl} returned status ${res.statusCode} within timeout`));
        } else {
          setTimeout(check, intervalMs);
        }
      });

      req.on("error", () => {
        if (Date.now() - startTime >= timeoutMs) {
          reject(new Error(`Server at ${statusUrl} was not ready within ${timeoutMs}ms`));
        } else {
          setTimeout(check, intervalMs);
        }
      });

      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - startTime >= timeoutMs) {
          reject(new Error(`Server check timed out after ${timeoutMs}ms`));
        } else {
          setTimeout(check, intervalMs);
        }
      });
    }

    check();
  });
}

module.exports = {
  waitForServerReady,
};
