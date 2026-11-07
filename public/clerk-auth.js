/**
 * Loads Clerk in the browser, shows the sign-in box or user button, and gives the app two helpers:
 *   apiFetch(url, options)       -> fetch() that adds the Clerk session token
 *   downloadFile(url, fallback)  -> authenticated download (for the pptx / html export links)
 *
 * Page setup (public/index.html):
 *   <div id="auth-root"></div>
 *   <script src="/clerk-auth.js"></script>
 * "auth-ready" fires once Clerk has loaded, and "auth-changed" fires on sign in / sign out.
 */
(function () {
  const root = document.getElementById('auth-root');
  let lastState = null;
  let mounted = null; // { kind, el }

  window.apiFetch = async function (url, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers);
    const session = window.Clerk && window.Clerk.session;
    const token = session ? await session.getToken() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, Object.assign({}, options, { headers }));
  };

  window.downloadFile = async function (url, fallbackName) {
    const res = await window.apiFetch(url);
    if (!res.ok) throw new Error('Download failed (' + res.status + ')');
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = match ? match[1] : (fallbackName || 'download');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  function showMessage(text) {
    if (root) root.textContent = text;
    console.error('[clerk-auth] ' + text);
  }

  function loadClerkScript(key) {
    // A publishable key looks like pk_test_<base64 of "your-frontend-api$">
    const frontendApi = atob(key.split('_')[2]).slice(0, -1);
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-clerk-publishable-key', key);
      s.src = 'https://' + frontendApi + '/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load Clerk JS from ' + frontendApi)); };
      document.head.appendChild(s);
    });
  }

  function render() {
    const signedIn = !!window.Clerk.user;
    if (signedIn === lastState) return;
    lastState = signedIn;

    if (mounted) {
      if (mounted.kind === 'signIn') window.Clerk.unmountSignIn(mounted.el);
      else window.Clerk.unmountUserButton(mounted.el);
      mounted.el.remove();
      mounted = null;
    }

    root.textContent = ''; // remove the "Loading sign-in..." placeholder
    const el = document.createElement('div');
    root.appendChild(el);
    if (signedIn) {
      window.Clerk.mountUserButton(el);
      mounted = { kind: 'userButton', el: el };
    } else {
      window.Clerk.mountSignIn(el);
      mounted = { kind: 'signIn', el: el };
    }

    // index.html shows the app only when body[data-auth="in"]
    document.body.dataset.auth = signedIn ? 'in' : 'out';
    window.dispatchEvent(new CustomEvent('auth-changed', { detail: { signedIn: signedIn } }));
  }

  async function init() {
    if (!root) return showMessage('Add <div id="auth-root"></div> to index.html');

    // If Clerk never finishes loading (ad blocker, VPN, blocked network), say so instead of hanging
    const watchdog = setTimeout(function () {
      showMessage('Sign-in is taking too long. Press F12 and check the Console, and turn off ad blockers.');
    }, 10000);

    try {
      const cfg = await (await fetch('/api/config')).json();
      if (!cfg.clerkPublishableKey) {
        clearTimeout(watchdog);
        return showMessage('Missing CLERK_PUBLISHABLE_KEY in .env (restart the server after adding it)');
      }
      await loadClerkScript(cfg.clerkPublishableKey);
      await window.Clerk.load();
      clearTimeout(watchdog);
      render();
      window.Clerk.addListener(render);
      window.dispatchEvent(new Event('auth-ready'));
    } catch (e) {
      clearTimeout(watchdog);
      showMessage(e.message);
    }
  }

  init();
})();