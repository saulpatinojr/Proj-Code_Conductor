# Security in TypeScript and JavaScript Agent Code

The Node.js security best practices page covers the runtime's threat model and mitigations: https://nodejs.org/en/learn/getting-started/security-best-practices

## Validation at boundaries

TypeScript types are erased at compile time and never change runtime behavior. Validate tool arguments, model output and request bodies with a schema library such as Zod, reject unknown keys where the contract is closed, and cap sizes. A value typed as `User` that came from `JSON.parse` is unchecked until it is validated.

## Code execution from data

- `eval` and `new Function` run arbitrary code, as do string arguments to `setTimeout` and `setInterval` in browsers.
- The `node:vm` module "is not a security mechanism. Do not use it to run untrusted code." Run model-generated code in a separate isolated process or container instead.

## Prototype pollution

Merging untrusted objects can set properties on `Object.prototype` through `__proto__`, `constructor` or `prototype` keys and change behavior across the whole process. Node.js recommends: avoid insecure recursive merges, validate input with a schema, create lookup objects with `Object.create(null)`, check own properties with `Object.hasOwn`, and consider the `--disable-proto` flag.

## Processes, files and network

- `child_process`: use `execFile` or `spawn` with an argument array; `exec` with a command string turns untrusted input into shell injection.
- Paths: resolve with `path.resolve` against the allowed root and check the result still starts with that root plus a path separator; reject absolute paths and `..` segments in tool arguments.
- SSRF: allow-list the hosts a tool may fetch, and handle redirects explicitly (`redirect: 'manual'`) so a redirect cannot reach an internal address.

## Denial of service

One event loop serves every request. A regular expression with catastrophic backtracking on hostile input (ReDoS), a huge `JSON.parse`, or CPU-heavy work blocks every client. Bound input sizes, avoid nested quantifiers on untrusted text, and move heavy work to worker threads or another service.

## Front-end exposure

Anything bundled for the browser is public, including environment variables that the build exposes to client code. Keep secrets on the server. In React, `dangerouslySetInnerHTML` and `javascript:` URLs bypass escaping.

## Supply chain

- Install from the lockfile with `npm ci`, which fails when the lockfile and `package.json` disagree, instead of `npm install`.
- npm runs lifecycle scripts such as `preinstall`, `install` and `postinstall` during installation, which is a common route for malicious packages. Install with `--ignore-scripts`, or set `npm config set ignore-scripts true`, and allow scripts only for packages that need them.
- Pin versions, check `package.json` for typosquatted names, and audit with `npm audit`. Since npm 11.10, `--min-release-age` delays installing newly published versions.
