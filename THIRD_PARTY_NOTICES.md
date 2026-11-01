# Third-party notices

## Runtime

ORNELYON has **no bundled runtime dependencies**. It uses Node.js built-in modules only.

It can call the following tools, but they are **not included** in this package. Each one must be installed separately by the user under its own license and terms.

| Tool | Publisher | License / terms | How ORNELYON uses it |
| --- | --- | --- | --- |
| Codex CLI (`@openai/codex`) | OpenAI | Apache-2.0 (checked in the package's `package.json`, version 0.162.1 on the development machine) | Executed as `codex exec`, `codex login status`, `codex --version` |
| Claude Code | Anthropic | Proprietary; governed by Anthropic's terms, see [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (not redistributed here) | Executed as `claude -p`, `claude auth status --json`, `claude --version` |
| Any OpenAI-compatible server (Ollama, LM Studio, llama.cpp server, vLLM, …) | Various | Depends on the server | Called over HTTP at the base URL set by the user |

## Development dependencies (not in the runtime package)

| Package | Version | License |
| --- | --- | --- |
| typescript | 5.9.3 | Apache-2.0 |
| @types/node | 20.19.43 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT. Used only by one test, as the official MCP client that checks ORNELYON's own MCP server over stdio. Not imported by any runtime file and not needed to run ORNELYON. |

## Reference projects (concepts only, no code copied)

| Project | License (per repository) | Status in ORNELYON |
| --- | --- | --- |
| google-research/harness2 | Apache-2.0 | Not integrated, not copied. Used as a design reference for the planned Research mode. |
| microsoft/TokenEconomizer | Apache-2.0 | Not integrated, not copied. Its loop-guard and tool-pruning ideas were re-implemented in ORNELYON's own code. |

Neither project is an official part of ORNELYON.

## Non-affiliation and trademarks

ORNELYON is an independent project. It is not affiliated with, endorsed by or sponsored by OpenAI, Anthropic, Google or Microsoft. "OpenAI", "Codex", "ChatGPT", "Anthropic", "Claude", "Claude Code", "Google", "Gemini" and "Microsoft" belong to their owners and are used only to name tools that a user may install separately. ORNELYON bundles none of them.

## How the official CLIs are used, and credentials

ORNELYON starts the Codex CLI and the Claude Code CLI that the user installed, unmodified, as ordinary child processes in their non-interactive modes, with the user's own environment. It does not read, copy, store, relay or send their login tokens or credential files, and it provides no sign-in of its own. Which sign-in or key a CLI uses, and how the call is billed, is decided by the CLI and by the user's environment, not by ORNELYON.

## Terms of use (status as of 2026-11-01)

Not confirmed: whether a third-party tool such as ORNELYON may drive `claude -p` with a Claude subscription sign-in (Anthropic), or `codex exec` with a ChatGPT sign-in (OpenAI), under the providers' terms. This file does not state that it is allowed or that it is prohibited, and a notice here does not resolve it. Users must read the current terms:

- Anthropic: https://www.anthropic.com/legal/consumer-terms, https://code.claude.com/docs/en/legal-and-compliance, https://code.claude.com/docs/en/headless
- OpenAI, users outside the EEA, Switzerland and the UK: https://openai.com/policies/terms-of-use/
- OpenAI, users in the EEA, Switzerland and the UK: https://openai.com/policies/eu-terms-of-use/
- OpenAI Codex authentication: https://developers.openai.com/codex/auth

## Gemini CLI

Gemini CLI is not implemented in v0.4.1 and is not supported. No code in ORNELYON starts it. ORNELYON will not support automated runs through a Google-account subscription or OAuth sign-in and will not obtain, reuse or relay such credentials. The Gemini API and Vertex AI are separate, unimplemented routes that would need explicit enabling and consent to billing.

## Attribution

If a future version bundles code from Apache-2.0 projects, this file will include their copyright notices and any NOTICE text they require.
