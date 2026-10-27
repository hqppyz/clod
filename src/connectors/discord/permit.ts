import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown, type ButtonInteraction, type Message, type SendableChannels } from 'discord.js';
import type { Session } from '../../session';

// Most of a tool call's input shown in its prompt
const MAX_INPUT = 1500;

const ALLOW = 'permit:allow';
const DENY = 'permit:deny';

// What a person would recognize the call by: a Bash command, a file, else the whole input
function shown(permission: Session.Permission): string {
  const { input } = permission;
  const detail = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input, null, 2);
  const cut = detail.length > MAX_INPUT ? `${detail.slice(0, MAX_INPUT - 1)}…` : detail;
  return `\`\`\`\n${cut.replace(/```/g, '`​``')}\n\`\`\``;
}

// Bash calls describe themselves in their input
function content(permission: Session.Permission, footer: string): string {
  const { description } = permission.input;
  const why = permission.reason ?? (typeof description === 'string' ? description : undefined);
  const title = `**${escapeMarkdown(permission.title ?? `Claude wants to use ${permission.tool}`)}**`;
  return [title, ...(why ? [escapeMarkdown(why)] : []), shown(permission), footer].join('\n');
}

// Prompts still waiting for an answer, by the message that asks them
const open = new Map<string, Permitting>();

// A click on a prompt's buttons; clicks on answered prompts, or on prompts
// from before a restart, are acknowledged and do nothing
export function decide(interaction: ButtonInteraction) {
  const permitting = open.get(interaction.message.id);
  if (permitting) permitting.decide(interaction.customId === ALLOW, interaction.user.tag);
  interaction.deferUpdate().catch(() => {});
}

export const isPermitButton = (customId: string) => customId === ALLOW || customId === DENY;

// A tool call waiting in a channel for Allow or Deny. Aborting the signal,
// as when it's answered elsewhere or the turn ends, rejects decided.
export class Permitting {
  private readonly done = Promise.withResolvers<Session.Decision>();
  readonly decided = this.done.promise;
  // Who decided and how, for the message
  private by = '';

  private constructor() {}

  static async post(channel: SendableChannels, permission: Session.Permission, signal: AbortSignal): Promise<Permitting> {
    const permitting = new Permitting();
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ALLOW).setLabel('Allow').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(DENY).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );
    const message: Message = await channel.send({ content: content(permission, '-# Admins only.'), components: [buttons] });

    open.set(message.id, permitting);
    const drop = () => permitting.done.reject(new Error('the prompt was answered elsewhere'));
    if (signal.aborted) drop();
    else signal.addEventListener('abort', drop, { once: true });
    // Shows the answer in place of the buttons
    permitting.decided
      .then(
        () => message.edit({ content: content(permission, `-# ${permitting.by}.`), components: [] }),
        () => message.edit({ content: content(permission, '-# No longer waiting.'), components: [] }),
      )
      .catch((e) => console.error('failed to close the prompt:', e))
      .finally(() => {
        open.delete(message.id);
        signal.removeEventListener('abort', drop);
      });
    return permitting;
  }

  decide(allow: boolean, by: string) {
    this.by = `${allow ? 'Allowed' : 'Denied'} by ${by}`;
    this.done.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: `${by} denied this` });
  }
}
