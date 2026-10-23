### Fixed

- A project plugin registry entry whose install path resolves inside the directory that owns that registry is no longer loaded. Entries outside that directory, including the user plugin cache, still load.
