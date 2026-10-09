### Fixed

- Configured secrets in unsigned thinking text and tool-call arguments are replaced before those messages leave the process. A signed thinking block or opaque redacted-thinking block that contains a secret is omitted instead of rewritten under its provider signature. Image payloads are not scanned.
