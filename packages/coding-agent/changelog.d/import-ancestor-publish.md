### Fixed

- Skill and hook import publication now creates and writes destination files through a no-follow directory descriptor, so replacing the destination directory with a symlink after validation cannot publish the file outside that directory.
