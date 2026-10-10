### Fixed
- Discord thread reconciliation and the thread-create response now bind a session only when the starter was posted by this bot and the thread's `parent_id` and `owner_id` identify that bot's thread in the configured parent.
