### Fixed

- Crash diagnostics ignore a project dotenv directory override from the environment-loading directory, including layered dotenv files, refuse a symlink directory, and scrub secrets before the saved stderr is truncated.
