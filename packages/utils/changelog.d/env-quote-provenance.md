### Fixed

- Project dotenv parsing now follows Bun's quoted newlines, so a double-quoted `GJC_CODING_AGENT_DIR` in `.env` stays untrusted instead of being read as an operator override.
