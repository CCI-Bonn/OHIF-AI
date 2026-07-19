// Lease-token holder for the MONAI nnInteractive session pool.
// Claims lazily on first use so idle viewers never hold a session slot;
// releases via sendBeacon on tab close (server idle-timeout is the backstop).

let token: string | null = null;
let claimPromise: Promise<string> | null = null;

export async function getNninterToken(): Promise<string> {
  if (token) {
    return token;
  }
  if (!claimPromise) {
    claimPromise = fetch('/monai/nninter/session/', { method: 'POST' })
      .then(r => {
        if (!r.ok) {
          throw new Error(`nninter session claim failed: HTTP ${r.status}`);
        }
        return r.json();
      })
      .then(j => {
        token = j.token;
        return token;
      })
      .finally(() => {
        claimPromise = null;
      });
  }
  return claimPromise;
}

export function clearNninterToken(): void {
  token = null;
}

window.addEventListener('pagehide', () => {
  if (token) {
    navigator.sendBeacon(`/monai/nninter/session/${token}/release`);
  }
});
