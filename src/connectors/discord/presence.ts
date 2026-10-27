import { ActivityType, type Guild, type PresenceStatusData, type Role } from 'discord.js';
import { Session } from '../../session';

// The bot's status turns idle, then do not disturb, as what's left of the 5-hour window drops below these
const IDLE_BELOW = 0.5;
const DND_BELOW = 0.25;

// Discord's own colors for each status, given to the bot's usage role
const COLORS = { online: 0x2ecc71, idle: 0xf1c40f, dnd: 0xe74c3c } as const;

// The reset times count down, so the status is redrawn while there is usage to show
const REFRESH_MS = 60_000;

let latest: { guild: Guild; event: Session.RateLimit } | undefined;
let timer: Timer | undefined;
let shown: string | undefined;
let named: string | undefined;
let colored: PresenceStatusData | undefined;
let role: Promise<Role> | undefined;

export function statusFor(event: Session.RateLimit): keyof typeof COLORS {
  const left = 1 - (event.rate_limit_info?.unifiedWindows?.five_hour?.utilization ?? 0);
  return left < DND_BELOW ? 'dnd' : left < IDLE_BELOW ? 'idle' : 'online';
}

// Shows the account's usage from a rate limit event in the bot's nickname in guild,
// its reset as the bot's custom status, and colors the bot's name after it
export function showUsage(guild: Guild, event: Session.RateLimit) {
  latest = { guild, event };
  draw();
  timer ??= setInterval(draw, REFRESH_MS);
}

// The bot's "<name>-usage" role, made and given to the bot if it's missing.
// It sits right below the bot's own role, the highest a bot can place a role,
// so its color beats other roles'; the bot's own role must have no color for
// this one to show.
async function usageRole(guild: Guild): Promise<Role> {
  const me = await guild.members.fetchMe();
  const name = `${me.user.username}-usage`;
  const top = me.roles.highest;
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) role = await guild.roles.create({ name, position: top.position, reason: 'Shows Claude usage' });
  // A re-invited bot gets a new role at the bottom, under an old usage role
  else if (role.comparePositionTo(top) >= 0) throw new Error(`move the bot's role ${top.name} above ${name}`);
  else if (role.position < top.position - 1) role = await role.setPosition(top.position - 1, { reason: 'Shows Claude usage' });
  if (!me.roles.cache.has(role.id)) await me.roles.add(role);
  return role;
}

// Role edits are rate limited, so the color only changes with the status
function color(guild: Guild, status: keyof typeof COLORS) {
  if (colored === status) return;
  colored = status;
  role ??= usageRole(guild);
  role
    .then((r) => r.setColors({ primaryColor: COLORS[status] }))
    .catch((e) => {
      role = undefined;
      colored = undefined;
      console.error('failed to color the usage role:', e);
    });
}

// Nickname edits are rate limited as well, so only a changed percent is sent
function rename(guild: Guild, percent: number) {
  const nick = `${guild.client.user.username} · ${percent}% remaining`;
  if (named === nick) return;
  named = nick;
  guild.members
    .fetchMe()
    .then((me) => me.setNickname(nick, 'Shows Claude usage'))
    .catch((e) => {
      named = undefined;
      console.error('failed to set the usage nickname:', e);
    });
}

function draw() {
  const client = latest?.guild.client;
  if (!latest || !client?.user) return;
  const window = Session.usage(latest.event);
  if (!window) return;
  const status = statusFor(latest.event);
  color(latest.guild, status);
  rename(latest.guild, window.percent);
  const text = window.reset ? `refreshing in ${window.reset}...` : undefined;
  // Presence updates are rate limited too, so an unchanged one isn't sent
  if (shown === `${status} ${text}`) return;
  shown = `${status} ${text}`;
  client.user.setPresence({ status, activities: text ? [{ type: ActivityType.Custom, name: 'usage', state: text }] : [] });
}
