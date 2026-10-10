### Fixed
- Discord thread reconciliation now adopts a public nonce marker only when the message was posted by this bot and the thread's `parent_id` and `owner_id` are that bot's thread in the configured parent, so a copied marker cannot rebind the session.
