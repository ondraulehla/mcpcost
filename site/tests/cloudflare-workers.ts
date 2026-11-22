/** The stand-in for cloudflare:workers in the tests: no bindings, so a test that reads the database fails loudly. */
export const env = {};
/** waitUntil of the Workers runtime keeps a promise alive after the answer; a test awaits its own work. */
export const waitUntil = (promise: Promise<unknown>): void => void promise;
