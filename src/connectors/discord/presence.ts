import { ActivityType, type Guild, type PresenceStatusData, type Role } from 'discord.js';
import { Session } from '../../session';

// The account's usage in the bot's nickname, its reset as the custom status,
// and the bot's name colored after it. Nickname, role and presence edits are
// rate limited, so each goes out only when it changes.
export class Presence {
  // Discord's own colors for each status
  private static readonly COLORS = { online: 0x2ecc71, idle: 0xf1c40f, dnd: 0xe74c3c } as const;
  private latest: Session.Limit | undefined;
  private timer: Timer | undefined;
  private shown: string | undefined;
  private named: string | undefined;
  private colored: PresenceStatusData | undefined;
  private role: Promise<Role> | undefined;

  constructor(private readonly guild: Guild) {}

  static status(event: Session.Limit): keyof typeof Presence.COLORS {
    const IDLE_BELOW = 0.5;
    const DND_BELOW = 0.25;
    const left = 1 - (event.rate_limit_info?.unifiedWindows?.five_hour?.utilization ?? 0);
    return left < DND_BELOW ? 'dnd' : left < IDLE_BELOW ? 'idle' : 'online';
  }

  // What's left of the 5-hour window, in percent, and the time to its reset as
  // its two largest units: 45m, 2h05m, 4d18h
  static usage(event: Session.Limit, now = Date.now()): { percent: number; reset?: string } | undefined {
    const w = event.rate_limit_info.unifiedWindows?.five_hour;
    if (!w) return undefined;
    const percent = Math.round((1 - (w.utilization ?? 0)) * 100);
    if (!w.resetsAt) return { percent };
    const minutes = Math.max(0, Math.round((w.resetsAt * 1000 - now) / 60_000));
    const [d, h, m] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60];
    const reset = d > 0 ? `${d}d${String(h).padStart(2, '0')}h` : h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
    return { percent, reset };
  }

  show(event: Session.Limit) {
    // The reset times count down, so the status is redrawn while there is usage to show
    const REFRESH_MS = 60_000;
    this.latest = event;
    this.draw();
    this.timer ??= setInterval(() => this.draw(), REFRESH_MS);
  }

  // It sits right below the bot's own role, the highest a bot can place a
  // role, so its color beats other roles'; the bot's own role must have no
  // color for this one to show
  private async made(): Promise<Role> {
    const me = await this.guild.members.fetchMe();
    const name = `${me.user.username}-usage`;
    const top = me.roles.highest;
    let role = this.guild.roles.cache.find((r) => r.name === name);
    if (!role) role = await this.guild.roles.create({ name, position: top.position, reason: 'Shows Claude usage' });
    // A re-invited bot gets a new role at the bottom, under an old usage role
    else if (role.comparePositionTo(top) >= 0) throw new Error(`move the bot's role ${top.name} above ${name}`);
    else if (role.position < top.position - 1) role = await role.setPosition(top.position - 1, { reason: 'Shows Claude usage' });
    if (!me.roles.cache.has(role.id)) await me.roles.add(role);
    return role;
  }

  private draw() {
    const client = this.guild.client;
    if (!this.latest || !client.user) return;
    const window = Presence.usage(this.latest);
    if (!window) return;
    const status = Presence.status(this.latest);

    if (this.colored !== status) {
      this.colored = status;
      this.role ??= this.made();
      this.role
        .then((r) => r.setColors({ primaryColor: Presence.COLORS[status] }))
        .catch((e) => {
          this.role = undefined;
          this.colored = undefined;
          console.error('failed to color the usage role:', e);
        });
    }

    const nick = `${client.user.username} · ${window.percent}% remaining`;
    if (this.named !== nick) {
      this.named = nick;
      this.guild.members
        .fetchMe()
        .then((me) => me.setNickname(nick, 'Shows Claude usage'))
        .catch((e) => {
          this.named = undefined;
          console.error('failed to set the usage nickname:', e);
        });
    }

    const text = window.reset ? `refreshing in ${window.reset}...` : undefined;
    if (this.shown === `${status} ${text}`) return;
    this.shown = `${status} ${text}`;
    client.user.setPresence({ status, activities: text ? [{ type: ActivityType.Custom, name: 'usage', state: text }] : [] });
  }
}
