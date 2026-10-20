### Fixed

- A project `.env` can no longer set `HINDSIGHT_API_URL`. The Hindsight client keeps a URL from the launching shell or from `hindsight.apiUrl`, including a loopback server, and a spawned child does not inherit the rejected project value.
