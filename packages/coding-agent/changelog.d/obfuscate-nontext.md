### Fixed

- Configured secrets in unsigned thinking text and tool-call arguments are replaced before those messages leave the process, and a signed thinking block, opaque redacted-thinking block, or replayed Responses reasoning item that contains a secret, including one that appears only after JSON decoding or that substitution would leave unchanged, is omitted instead of being rewritten under its provider signature.
