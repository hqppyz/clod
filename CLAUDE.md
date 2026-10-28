## Code style

- Keep logic where it's used. A helper must serve code reused in more than one place.
- Prefer a method on the instance it describes over a free helper.
- Keep symbols in their namespace: `Session.Options`, not `SessionOptions`.
- Name symbols with one word when possible; the namespace carries the rest.
- Make values like regexps and limits named constants, in the narrowest scope all their uses share: function body, class, namespace, then file.
- Match the surrounding code's comments: say why, not what.

## Tooling

Bun, not Node: `bun <file>`, `bun test` (`bun:test`), `bun install`, `bunx`. Bun loads `.env` itself.
Prefer Bun APIs (`Bun.file`, `Bun.$`, `Bun.spawn`) over `node:` ones and npm packages.
Typecheck with `bunx tsc --noEmit -p .`.
