### Fixed

- Project dotenv parsing now follows Bun's quotes, comments, and whitespace, and credential provenance compares that raw value, so a declaration such as `GJC_CODING_AGENT_DIR` in `.env` stays untrusted instead of being read as an operator override.
