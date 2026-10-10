### Fixed

- LSP `rename_file` refuses a path outside the workspace, including a path an earlier rename in the same edit would retarget, and checks every server edit before it writes.
