# Security policy

## Supported versions

ORNELYON v0.4.2 is a **Public Preview**. Only the latest released version receives security fixes. Older versions (v0.2.1, v0.3.0, v0.3.1, v0.4.1) are not supported.

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or discussion.

Use GitHub's private vulnerability reporting for this repository: open the **Security** tab and choose **Report a vulnerability** (https://github.com/amane3914/ORNELYON/security/advisories/new). Reports are visible only to the maintainer until they are published.

When you report, include, if you can:

- the version and your operating system and Node.js version;
- the steps to reproduce, and what you expected and what happened;
- whether a secret, a file outside the workspace, or a sign-in token could be exposed.

Do not include real API keys, sign-in tokens or private data in the report. Describe the shape of the data instead.

## Scope

In scope: ORNELYON's own code. For example, a way to read or write outside the configured workspace, to bypass the sandbox defaults or the local GUI protections (127.0.0.1 binding, Host check, per-launch token), to leak a key or token into logs, history, passports or handoff text, or to start an agent without the user's request.

Out of scope: the Codex CLI, the Claude Code CLI, local model servers and other third-party tools. Report those to their own vendors. Also out of scope: findings that depend on running ORNELYON with a configuration that the README calls unsafe.

## What to expect

This is a small project with one maintainer. The maintainer will try to acknowledge a report, but no response time is promised. Please allow time for a fix before any public disclosure.
