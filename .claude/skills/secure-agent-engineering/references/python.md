# Security in Python Agent Code

The Python documentation keeps a list of standard-library modules with security considerations; read the page for the modules a change touches: https://docs.python.org/3/library/security_warnings.html

## Code execution from data

- `pickle` is not secure: "It is possible to construct malicious pickle data which will execute arbitrary code during unpickling." The same applies to `shelve`, and `multiprocessing` connections use pickle when receiving. Use JSON, or sign data with `hmac` when integrity matters.
- `eval` and `exec` on model output, tool results or user input run arbitrary code. Parse with `json` or `ast.literal_eval` for literals, and validate with a schema.
- YAML: `yaml.safe_load` in PyYAML, never `yaml.load` with an unsafe loader on untrusted input.
- `logging.config` can evaluate configuration; never accept logging configuration from untrusted sources.

## Processes, files and archives

- `subprocess`: pass an argument list and keep `shell=False`. With `shell=True`, untrusted input becomes shell injection.
- Paths: resolve the final path and check it stays inside the allowed root with `Path.resolve()` and `is_relative_to()`; reject absolute paths and `..` segments in tool arguments.
- Temporary files: use `tempfile.mkstemp`, `NamedTemporaryFile` or `TemporaryDirectory`; `mktemp` is deprecated because of race conditions.
- XML: the standard-library parsers are not safe against hostile documents; see the XML security notes and prefer a hardened parser for untrusted input.
- Archives: a crafted `.zip` can exhaust disk space; limit sizes and member counts before extracting.

## Randomness, servers and the interpreter

- Use `secrets`, not `random`, for tokens and identifiers.
- `http.server` is not suitable for production.
- Run helper scripts with `python -I` (isolated mode) so the current directory cannot inject modules.

## Validation at boundaries

Type hints are not enforced at runtime. Validate tool arguments, model output and request bodies with a schema library such as Pydantic, reject unknown fields where the contract is closed, and cap sizes.

## Supply chain

- Pin dependencies with a lockfile (`uv.lock`, `poetry.lock`) or a requirements file in hash-checking mode with `--require-hashes`.
- Building a source distribution runs its build backend's code on the installing machine; prefer wheels from trusted indexes.
- Audit with pip-audit, and scan code with the repository's tools, for example bandit or ruff's security rules.
