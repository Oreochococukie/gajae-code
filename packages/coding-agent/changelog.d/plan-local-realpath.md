### Fixed

- Plan mode refuses a `local://` write, link, or unlink unless the real path stays inside the real session local root, including a dangling symlink whose real path cannot be resolved.
