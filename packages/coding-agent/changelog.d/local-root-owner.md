### Fixed

- A managed local:// root and its temp parent are adopted only when this user owns them and they are not group- or world-writable, and a later resolve refuses that root when the directory has been replaced.
