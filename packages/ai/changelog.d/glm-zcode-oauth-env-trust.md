### Fixed

- GLM ZCode OAuth endpoints and the client id (`ZCODE_OAUTH_*`) now resolve from the launching shell and user-owned env files, so a project `.env` cannot redirect the authorize, broker, or login calls.
