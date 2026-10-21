### Fixed

- Project memory directories percent-encode `-`, `:`, `\`, and `%` so those characters no longer alias a slash, and an over-long name uses a short hash shared by the writer and the memory URL reader.
