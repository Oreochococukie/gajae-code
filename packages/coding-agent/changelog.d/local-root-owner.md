### Fixed

- A managed local:// root that already exists is adopted only when the current user owns it and it is not group- or world-writable. A later sync resolve refuses that root when its device, inode, owner, or mode no longer matches the directory recorded at init.
