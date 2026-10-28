import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown, type ButtonInteraction, type Message, type SendableChannels } from 'discord.js';
import type { Session } from '../../session';
import { cut } from './text';

// Rejects decided once the signal aborts, as when it's answered elsewhere or the turn ends
export class Permitting {
  private static readonly ALLOW = 'permit:allow';
  private static readonly DENY = 'permit:deny';
  // By the message that asks them
  private static readonly open = new Map<string, Permitting>();
  private readonly done = Promise.withResolvers<Session.Decision>();
  readonly decided = this.done.promise;
  // For the message
  private by = '';

  private constructor() {}

  static owns(id: string) {
    return id === Permitting.ALLOW || id === Permitting.DENY;
  }

  // Clicks on answered prompts, or on prompts from before a restart, are
  // acknowledged and do nothing
  static click(interaction: ButtonInteraction) {
    Permitting.open.get(interaction.message.id)?.decide(interaction.customId === Permitting.ALLOW, interaction.user.tag);
    interaction.deferUpdate().catch(() => {});
  }

  private static content(permission: Session.Permission, footer: string): string {
    const MAX_INPUT = 1500;
    const { input } = permission;
    // Bash calls describe themselves in their input
    const why = permission.reason ?? (typeof input.description === 'string' ? input.description : undefined);
    const title = `**${escapeMarkdown(permission.title ?? `Claude wants to use ${permission.tool}`)}**`;
    const detail = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input, null, 2);
    const shown = `\`\`\`\n${cut(detail, MAX_INPUT).replace(/```/g, '`​``')}\n\`\`\``;
    return [title, ...(why ? [escapeMarkdown(why)] : []), shown, footer].join('\n');
  }

  static async post(channel: SendableChannels, permission: Session.Permission, signal: AbortSignal): Promise<Permitting> {
    const permitting = new Permitting();
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(Permitting.ALLOW).setLabel('Allow').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(Permitting.DENY).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );
    const message: Message = await channel.send({ content: Permitting.content(permission, '-# Admins only.'), components: [buttons] });

    Permitting.open.set(message.id, permitting);
    const drop = () => permitting.done.reject(new Error('the prompt was answered elsewhere'));
    if (signal.aborted) drop();
    else signal.addEventListener('abort', drop, { once: true });
    permitting.decided
      .then(
        () => message.edit({ content: Permitting.content(permission, `-# ${permitting.by}.`), components: [] }),
        () => message.edit({ content: Permitting.content(permission, '-# No longer waiting.'), components: [] }),
      )
      .catch((e) => console.error('failed to close the prompt:', e))
      .finally(() => {
        Permitting.open.delete(message.id);
        signal.removeEventListener('abort', drop);
      });
    return permitting;
  }

  decide(allow: boolean, by: string) {
    this.by = `${allow ? 'Allowed' : 'Denied'} by ${by}`;
    this.done.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: `${by} denied this` });
  }
}
