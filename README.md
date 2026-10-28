# clod

Gives each of your directories its own [Claude Code](https://claude.com/claude-code) session, reachable remotely through connectors:
- a Discord channel.
- remote controllable Claude chat.

## ⚠️ Permissions ⚠️

Claude can only do what its [permission mode](https://code.claude.com/docs/en/permissions) allows. The default `settings.json` starts instances in `auto`; a path can pick another mode with `args: ['--permission-mode', ...]`. A tool call the mode doesn't approve asks the connectors serving the session: Allow and Deny buttons in Discord, for admins only, and the usual prompt in the Claude app. The first answer wins. Without a connector that can answer, it's denied.

> **🛑 CLAUDE RUNS ON YOUR MACHINE 🛑**<br>With a permissive mode (`auto`, `acceptEdits`, `bypassPermissions`), **anyone who can write to clod can change your files**. **This includes the default permission mode**.<br>If you're using discord, keep `admin-only: true` unless only people you trust can write in the server.

## Setup

Needs [bun](https://bun.com) and the `claude` CLI on `PATH`.

1. Create the data folder.
   ```bash
   cp -r .clod ~/.clod
   ```
2. Setup the controllers by editing `~/.clod/config.yaml`.
3. OPTIONAL: Provide the DISCORD_TOKEN either in `~/.clod/config.yaml` or in `~/.clod/.env`
4. Install the dependencies.
   ```bash
   bun install
   ```
4. Run the service.
   ```bash
   bun run index.ts --data ~/.clod
   ```

Every reference to `~/.clod` in this documentation can be replaced with the actual data directory you run the service with.

On first run clod prints a link to log claude in, and reads the code back from the terminal;
<br>Discord also DMs the admins the link, with a button to paste the code.
<br>The first code to work logs it in for all.

## Config

`config.yaml` has three parts:

- `claude`: `args` and `env` for every instance.
- `paths`: the directories that get sessions.
  - With `mode: manual` you get one session for the path itself.
  - With `mode: auto` you get a session per directory:
    - only directories in `include` are included;
    - and directories in `except` are explicitly excluded.
  - Each entry can add `args` and `env`, and set per connector options under `connectors`, keyed by connector name.
- `connectors`: the backends, keyed by name, each with a `type`. A connector is off unless `enabled: true`, whatever the paths say.

The example `config.yaml` shows every key.

A connector's token can stay out of `config.yaml` if set with the env variable `<NAME>_TOKEN`. These go into `~/.clod/.env`.

## Connectors

### Discord
A single server bot: manual paths link an existing channel, auto paths get a channel per session, under a category or at the top of the server. Channels are created, ordered and deleted as directories come and go; other channels are left alone.

Create a bot in the [Developer Portal](https://discord.com/developers/applications).<br>Turn on **Message Content Intent**. <br>Invite it with the `bot` and `applications.commands` scopes and the `View Channels`, `Send Messages`, `Read Message History`, `Manage Channels`, `Manage Messages` and `Manage Roles` permissions.<br>Keep the bot's role above its `<name>-usage` role, or it can't give that role to itself.

Claude's slash commands work as Discord commands. The bot adds four, for admins only:

- `/clean`: delete every message in the channel and clear the conversation
- `/restart`: restart the channel's claude process; the conversation resumes
- `/reboot`: restart all of clod
- `/stop`: stop all of clod, after a confirmation button

`/restart`, `/reboot` and `/stop` only run as Discord commands; typed as messages, they're refused.

### Remote Control

Sessions show up in claude.ai/code and the Claude app. Typing `/restart`, `/reboot` or `/stop` there runs clod's own command, without confirmation, as the app is the account owner's.

## CLAUDE.md

If `<data>/CLAUDE.md` exists, the bot copies it to `~/.clod/.claude/CLAUDE.md` whenever an instance starts, so Claude reads it as its user-level instructions. Edits Claude makes to the copy last until the next instance starts. A symlink works, e.g. `ln -s ~/.claude/CLAUDE.md ~/.clod/CLAUDE.md`. Without the file, no instructions are installed.

The copy fills in `{{DATA_DIR}}`, the data dir's absolute path. Other `{{...}}` stay as written.

## CONNECTORS.md

Each instance learns which connectors reach it through `--append-system-prompt`: `<data>/CONNECTORS.md`, with `{{CONNECTORS}}` filled in by one `<data>/CONNECTORS.<type>.md` per connector serving the session. Those fill in `{{CONNECTOR}}`, the connector's name, and Discord's also `{{BOT_NAME}}`, the bot's Discord username. Without `CONNECTORS.md`, nothing is appended; without a type's file, its connector is left out.

## settings.json

If `<data>/settings.json` exists, the bot merges it into `<data>/.claude/settings.json` whenever an instance starts. The merge follows JSON Merge Patch (RFC 7396): objects merge key by key, other values (arrays included) replace the old ones, and keys the file doesn't name stay as they are. Set a key to `null` to remove it:

```json
{
  "model": "opus",
  "env": { "DEBUG": null }
}
```

Its strings fill in `{{HOME}}`, your home directory. Other `{{...}}` stay as written.

The default effort is `--effort low` in `claude.args`; `/effort` changes it for the conversation, which keeps it across restarts until `/clear`. A path forces one with `CLAUDE_CODE_EFFORT_LEVEL` in its `env`.

## Trimmed instances

To keep each request small, the default `.clod` dir runs instances with less than a plain `.claude`:

- `config.yaml`, under `claude.env`: no claude.ai connectors (`ENABLE_CLAUDEAI_MCP_SERVERS=false`)
- `config.yaml`, under `claude.args`: tools a remote chat has no use for are disabled: `ReportFindings`, `ListAgents`, `ScheduleWakeup`
- `settings.json`: no skills or plugins synced from claude.ai
- `settings.json`: built-in skills hidden from Claude, still runnable as slash commands: `dataviz`, `claude-api`, `run`, `plugin-authoring`, `security-review`, `keybindings-help`, `fewer-permission-prompts`, `update-config`, `loop`

## Your ~/.claude

Instances use `~/.clod/.claude` as their Claude home, not `~/.claude`. Claude still finds `~/.claude` as project config in two ways:

- An instance in your home directory loads it as its project `.claude`: settings, skills, agents and CLAUDE.md. The example config passes `--setting-sources user` to the home entry, which skips project and local settings.
- An instance in a subdirectory loads `~/.claude/CLAUDE.md` and `~/.claude/rules` while walking up for CLAUDE.md files. The default `settings.json` excludes them with `claudeMdExcludes`.

The default makes sure these arent loaded as they might increase the token usage. You can change this editing `settings.json`.

## License

[WTFPL](LICENSE)
