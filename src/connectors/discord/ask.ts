import {
  ActionRowBuilder,
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  type Message,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Session } from '../../session';
import { cut } from './text';

// Each question gets a select menu, and a typed message answers every question
// still open, for answers the options don't cover. Answered questions keep
// their message as is, menus included.
export class Asking {
  // By the message that asks them
  private static readonly open = new Map<string, Asking>();
  private readonly answers = new Map<number, string>();
  private readonly done = Promise.withResolvers<Record<string, string>>();
  // Rejects once the signal aborts
  readonly answered = this.done.promise;

  private constructor(private readonly questions: readonly Session.Question[]) {}

  // Picks on answered questions, or on questions from before a restart, are
  // acknowledged and do nothing
  static pick(interaction: StringSelectMenuInteraction) {
    Asking.open.get(interaction.message.id)?.select(Number(interaction.customId), interaction.values);
    interaction.deferUpdate().catch(() => {});
  }

  // A message of components, so each question sits above its menu and the hint below them all
  private static box(questions: readonly Session.Question[], rows: readonly ActionRowBuilder<StringSelectMenuBuilder>[], footer: string) {
    // Discord's limit on the text of a message made of components
    const MAX_TEXT = 4000;
    const box = new ContainerBuilder();
    questions.forEach((q, i) => {
      if (i > 0) box.addSeparatorComponents(new SeparatorBuilder());
      box.addTextDisplayComponents(new TextDisplayBuilder().setContent(cut(`**${escapeMarkdown(q.question)}**`, MAX_TEXT / (questions.length + 1))));
      if (rows[i]) box.addActionRowComponents(rows[i]!);
    });
    return box.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
  }

  static async post(channel: SendableChannels, questions: readonly Session.Question[], signal: AbortSignal): Promise<Asking> {
    // Discord's limits on a select menu
    const MAX_OPTIONS = 25;
    const MAX_LABEL = 100;
    const MAX_PLACEHOLDER = 150;
    const asking = new Asking(questions);
    const rows = questions.map((q, i) => {
      const options = q.options.slice(0, MAX_OPTIONS);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(String(i))
        .setPlaceholder(cut(q.header || q.question, MAX_PLACEHOLDER))
        .setMinValues(1)
        .setMaxValues(q.multiSelect ? options.length : 1)
        .addOptions(
          options.map((o, j) => ({
            label: cut(o.label, MAX_LABEL),
            value: String(j),
            ...(o.description ? { description: cut(o.description, MAX_LABEL) } : {}),
          })),
        );
      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    });
    const message: Message = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [Asking.box(questions, rows, '-# ...or type an answer.')],
    });

    Asking.open.set(message.id, asking);
    const skip = () => asking.done.reject(new Error('the questions were skipped'));
    if (signal.aborted) skip();
    else signal.addEventListener('abort', skip, { once: true });
    asking.answered
      .catch(() => message.edit({ components: [Asking.box(questions, [], '-# Skipped.')] }))
      .catch((e) => console.error('failed to close the question:', e))
      .finally(() => {
        Asking.open.delete(message.id);
        signal.removeEventListener('abort', skip);
      });
    return asking;
  }

  // values are option indexes
  select(i: number, values: readonly string[]) {
    const options = this.questions[i]?.options;
    if (!options) return;
    this.answers.set(i, values.map((v) => options[Number(v)]!.label).join(', '));
    this.check();
  }

  type(text: string) {
    this.questions.forEach((_, i) => {
      if (!this.answers.has(i)) this.answers.set(i, text);
    });
    this.check();
  }

  private check() {
    if (this.answers.size < this.questions.length) return;
    this.done.resolve(Object.fromEntries(this.questions.map((q, i) => [q.question, this.answers.get(i)!])));
  }
}
