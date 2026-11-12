# Project rules

## Stack
- Package management: Poetry. Never use bare `pip install` — add deps via
  `poetry add`.
- Web framework: FastAPI for services; async endpoints by default.
- HTTP clients: httpx (async), with explicit timeouts and rate limiting for
  external API calls.
- CLI tools: Click + rich for anything user-facing on the command line.
- DB access: asyncpg for PostgreSQL; no raw sync psycopg in new code.
- Testing: pytest. New logic needs at least one test covering the happy path
  and one covering a realistic failure/edge case.

## Code style
- Full type hints on function signatures (params + return). No bare `Any`
  without a comment explaining why.
- Docstrings on public functions/classes: one-line summary + Args/Returns
  when non-trivial. [confirm: Google style]
- [confirm: formatter — black/ruff format? line length?]
- [confirm: linter — ruff, flake8?]
- [confirm: mypy strictness level, if used]
