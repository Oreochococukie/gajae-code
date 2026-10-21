### Fixed

- A repository skill body is fenced as untrusted content when it is inserted into the model prompt, an end tag inside that body stays escaped, and a body past the session text cap is shortened before the fence so the closing fence and host trailer remain.
