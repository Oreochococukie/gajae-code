### Fixed

- A project plugin registry entry whose install path resolves inside the repository is no longer loaded. Entries that point outside the repository, including the user plugin cache, still load.
