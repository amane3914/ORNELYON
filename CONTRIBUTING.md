# Contributing to ORNELYON

Thank you for looking at ORNELYON. This is a small, local project released under the MIT license. The rules below are short on purpose.

## You may fork, modify, redistribute and use it commercially

ORNELYON is released under the MIT license (see [LICENSE](LICENSE)). You may:

- fork it and modify it, for any purpose, including commercial use;
- redistribute the original or your modified version;
- use it inside your own products or services.

You do **not** have to tell the maintainer about your changes, ask permission, or send them back. Sharing your changes is encouraged, but it is never a condition.

Adding anything beyond the MIT license terms (a notice, a royalty, a contribution duty) is not part of this project's rules, and no contributor is asked to accept one.

## Pull requests

Pull requests are welcome. Please keep them focused, and explain the problem and the change in the description.

- Whether a change is merged into the upstream project is decided by review. A merge is not guaranteed, and the maintainer may ask for changes or decline a change for reasons of scope or safety.
- Run `npm test` before you open a pull request. It runs offline and makes no paid or metered agent call.
- Do not add a dependency at runtime. The project has no runtime dependencies on purpose.
- Do not include secrets, sign-in tokens, API keys, personal data or real history files in a commit or a pull request. Use fixtures that are clearly fake.
- Changes to the safety behaviour (sandbox defaults, workspace boundary, verification rules, redaction) need a test that fails without the change.

## External AI services

ORNELYON can start the Codex CLI, the Claude Code CLI or a local OpenAI-compatible server. Each external service is governed by its own terms of use, billing and sign-in rules. The license of this project does not grant any right to use those services, and it does not change what they allow. Read [README.md](README.md#accounts-billing-and-provider-terms) before you use a sign-in with a provider.

## Reporting bugs and security problems

- Ordinary bugs: open an issue. Follow the steps in the README section "Reporting a problem".
- Security problems: do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Discussion

Questions, ideas and show-and-tell posts are welcome in the project's discussion area, once it is enabled.
