/**
 * Page loads the service worker leaves to the hub instead of answering with the app: the API, and files such as
 * /LICENSE-lucide.txt (linked from Settings). Workbox tests these against the path and query string.
 */
export const NAVIGATION_DENYLIST: RegExp[] = [/^\/api(?:[/?]|$)/, /\/[^/?]*\.[a-z0-9]+(?:\?|$)/i];

/** True when the service worker answers a page load for `pathAndQuery` with the app. */
export const servesApp = (pathAndQuery: string): boolean => !NAVIGATION_DENYLIST.some((re) => re.test(pathAndQuery));
