# YesChef

A desktop workbench where Claude, Codex, and Grok work side by side on your projects, with a chef that splits a goal into work, hands it to them, and reviews the result.

[繁體中文](README.zh-TW.md)

## What it does

- **Conversations per project.** Open Claude, Codex, or Grok conversations in tabs, each with its own browser pane the agent can see and drive (click, type, screenshot, read the page).
- **Chef tasks.** Give the chef a goal. It plans, delegates units of work to whichever provider fits, checks that every claimed result cites a tool call that actually succeeded, and adds a review step, preferring a provider other than the one that did the work, before the task completes.
- **Group channel.** Agents in the same project can ask each other questions and post updates in a shared channel you can read and join.
- **Approvals you control.** Edits and commands wait for your approval unless you granted that kind of operation for the project. Every decision is recorded.
- **Terminals, diffs, documents.** tmux-backed terminals, a diff view of what each conversation changed (across nested repos), and a document preview with an outline.
- **Test machines.** Store staging logins once; agents sign in through a tool without ever seeing the password.
- **Error intake.** Point YesChef at a MySQL database, enable error intake on a project, and the chef installs [`@yeschef/error-intake`](packages/error-intake) into it and opens a pull request. Later, pull recorded errors into the group channel and hand them to the chef to fix.
- **Shared skills.** Install skills from a public GitHub repository once and use them in Claude and Codex conversations.

## Status

YesChef is developed and tested on macOS. It runs from source in development mode; there is no packaged installer yet.

## Requirements

- macOS
- Node.js 24 (Node 20 works for the error-intake package)
- [tmux](https://github.com/tmux/tmux) for terminal tabs
- A signed-in [Claude Code](https://code.claude.com) for Claude conversations
- Optional: the [Codex CLI](https://github.com/openai/codex) for Codex conversations, the Grok CLI for Grok conversations
- Optional: MySQL 8 for error intake

## Getting started

```bash
git clone https://github.com/hanfour/yeschef.git
cd yeschef
npm install
npm run dev
```

Add a project folder from the left pane, then start a conversation or open the chef.

## Development

```bash
npm run typecheck
npm test
npm run verify -- --list   # end-to-end checks that drive a real window
```

Design notes and acceptance records live in [`docs/`](docs) (written in Traditional Chinese). Specs are in [`docs/specs`](docs/specs).

## Packages

| Package | Description |
| --- | --- |
| [`@yeschef/error-intake`](packages/error-intake) | Records server and browser errors from Express, NestJS, and Next.js apps into MySQL, grouped and masked, so they can be pulled into YesChef and fixed. |

## License

[MIT](LICENSE)
