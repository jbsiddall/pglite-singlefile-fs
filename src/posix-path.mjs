/**
 * Pure-JS POSIX path helpers with zero Node.js built-in imports
 * so SingleFileFS works identically in Node.js, Bun, Deno, and Browsers.
 */

export function posixResolve(p) {
  if (typeof p !== 'string') throw new TypeError('path must be a string');
  const parts = p.split('/');
  const stack = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return '/' + stack.join('/');
}

export function posixDirname(p) {
  const resolved = posixResolve(p);
  if (resolved === '/') return '/';
  const idx = resolved.lastIndexOf('/');
  return idx <= 0 ? '/' : resolved.slice(0, idx);
}
