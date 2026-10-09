### Fixed

- `ast_edit` apply checks the real write path, so a directory symlink such as `src` → `.gjc` cannot bypass the `.gjc/**` block.
