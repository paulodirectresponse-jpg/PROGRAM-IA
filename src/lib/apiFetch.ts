/** Keep session cookies HttpOnly; attach the CSRF token only to this app's API. */
export function installApiFetch() {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return original(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const token = document.cookie.split('; ').find(value => value.startsWith('forge_csrf='))?.slice(11);
    if (token) headers.set('x-csrf-token', decodeURIComponent(token));
    return original(input, { ...init, headers });
  };
}
