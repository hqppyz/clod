# clod

Discord bot that gives each of your directories a channel with its own [Claude Code](https://claude.com/claude-code) session.

## Permissions

Claude can only do what its [permission mode](https://code.claude.com/docs/en/permissions) allows; everything else is denied. Sessions start in `manual`, where Claude mostly reads. Pick a looser mode globally or per path in the config.

> **⚠️ SESSIONS RUN ON YOUR MACHINE ⚠️**<br>With a permissive mode (`auto`, `acceptEdits`, `bypassPermissions`), **anyone who can write in a bot channel can change your files**.<br>Keep `admin-only: true` unless only people you trust can write in the server.

## Setup

Needs [bun](https://bun.com) and the `claude` CLI on `PATH`.

1. Create a bot in the [Developer Portal](https://discord.com/developers/applications).<br>Turn on **Message Content Intent**. <br>Invite it with the `bot` and `applications.commands` scopes and the View Channels, Send Messages, Read Message History, Manage Channels, Manage Messages and Manage Roles permissions.<br>Keep the bot's role above its `<name>-usage` role, or it can't give that role to itself.
2. Configure and run:

   ```bash
   bun install
   cp -r data ~/.clod  # then edit ~/.clod/config.yaml
   bun run index.ts --data ~/.clod
   ```

On first run the bot DMs the admins a link to log claude in.

Every config key can also come from the environment: `DISCORD_TOKEN`, `DISCORD_SERVER_ID`, `PATHS`, `CLAUDE_ARGS`, …

`data/` is the default data dir: `config.yaml`, `CLAUDE.md` and `settings.json`, all optional to keep. Running the bot with `--data ./data` works too; what it writes there is git-ignored.

## CLAUDE.md

If `<data>/CLAUDE.md` exists, the bot copies it to `<data>/.claude/CLAUDE.md` whenever a session starts, so Claude reads it as its user-level instructions. Edits Claude makes to the copy last until the next session. A symlink works, e.g. `ln -s ~/.claude/CLAUDE.md ~/.clod/CLAUDE.md`. Without the file, no instructions are installed.

The copy fills in `{{DATA_DIR}}`, the data dir's absolute path, and `{{BOT_NAME}}`, the bot's Discord username. Other `{{...}}` stay as written.

## settings.json

If `<data>/settings.json` exists, the bot merges it into `<data>/.claude/settings.json` whenever a session starts. The merge follows JSON Merge Patch (RFC 7396): objects merge key by key, other values (arrays included) replace the old ones, and keys the file doesn't name stay as they are. Set a key to `null` to remove it:

```json
{
  "model": "opus",
  "env": { "DEBUG": null }
}
```

## Commands

Claude's slash commands work as Discord commands. The bot adds three, for admins only:

- `/clean`: delete every message in the channel and clear the conversation
- `/restart session|bot`: restart the channel's Claude process, or the whole bot
- `/stop`: stop the whole bot, after a confirmation button

## Trimmed sessions

To keep each request small, the default data dir runs sessions with less than a plain `claude`:

- `config.yaml`, under `claude.env`: no claude.ai connectors (`ENABLE_CLAUDEAI_MCP_SERVERS=false`)
- `config.yaml`, under `claude.args`: tools a Discord chat has no use for are disabled: `ReportFindings`, `ListAgents`, `ScheduleWakeup`
- `settings.json`: no skills or plugins synced from claude.ai
- `settings.json`: built-in skills hidden from Claude, still runnable as slash commands: `dataviz`, `claude-api`, `run`, `plugin-authoring`, `security-review`, `keybindings-help`, `fewer-permission-prompts`, `update-config`, `loop`

## Your ~/.claude

Sessions use `<data>/.claude` as their Claude home, not `~/.claude`. Claude still finds `~/.claude` as project config in two ways:

- A session in your home directory loads it as its project `.claude`: settings, skills, agents and CLAUDE.md. The example config passes `--setting-sources user` to the home entry, which skips project and local settings.
- A session in a subdirectory loads `~/.claude/CLAUDE.md` and `~/.claude/rules` while walking up for CLAUDE.md files. The default `settings.json` excludes them with `claudeMdExcludes`.

## License

[WTFPL](LICENSE)
