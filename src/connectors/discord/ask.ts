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

// Discord's limit on the text of a message made of components
const MAX_TEXT = 4000;

// Discord's limits on a select menu: options, and the length of a label,
// description or placeholder
const MAX_OPTIONS = 25;
const MAX_LABEL = 100;
const MAX_PLACEHOLDER = 150;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const text = (content: string) => new TextDisplayBuilder().setContent(content);

// The questions in one box, each above its menu when it has one and split from the next by a line
function box(questions: readonly Session.Question[], rows: readonly ActionRowBuilder<StringSelectMenuBuilder>[], footer: string) {
  const box = new ContainerBuilder();
  questions.forEach((q, i) => {
    if (i > 0) box.addSeparatorComponents(new SeparatorBuilder());
    box.addTextDisplayComponents(text(cut(`**${escapeMarkdown(q.question)}**`, MAX_TEXT / (questions.length + 1))));
    if (rows[i]) box.addActionRowComponents(rows[i]!);
  });
  return box.addTextDisplayComponents(text(footer));
}

// Questions still waiting for an answer, by the message that asks them
const open = new Map<string, Asking>();

// A pick in a question's menu. Picks on answered questions, or on questions
// from before a restart, are acknowledged and do nothing.
export function pick(interaction: StringSelectMenuInteraction) {
  open.get(interaction.message.id)?.select(Number(interaction.customId), interaction.values);
  interaction.deferUpdate().catch(() => {});
}

// A question waiting in a channel. Each question gets a select menu, and a
// typed message answers every question still open, for answers the options don't
// cover. Aborting the signal skips the questions and rejects answered.
// Answered questions keep their message as is, menus included.
export class Asking {
  private readonly answers = new Map<number, string>();
  private readonly done = Promise.withResolvers<Record<string, string>>();
  readonly answered = this.done.promise;

  private constructor(private readonly questions: readonly Session.Question[]) {}

  static async post(channel: SendableChannels, questions: readonly Session.Question[], signal: AbortSignal): Promise<Asking> {
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
    // A message of components, so each question sits above its menu and the hint below them all
    const message: Message = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [box(questions, rows, '-# ...or type an answer.')],
    });

    open.set(message.id, asking);
    const skip = () => asking.done.reject(new Error('the questions were skipped'));
    if (signal.aborted) skip();
    else signal.addEventListener('abort', skip, { once: true });
    asking.answered
      .catch(() => {
        // Shows that the questions were skipped in place of the menus
        return message.edit({ components: [box(questions, [], '-# Skipped.')] });
      })
      .catch((e) => console.error('failed to close the question:', e))
      .finally(() => {
        open.delete(message.id);
        signal.removeEventListener('abort', skip);
      });
    return asking;
  }

  // A pick in question i's menu, as option indexes
  select(i: number, values: readonly string[]) {
    const options = this.questions[i]?.options;
    if (!options) return;
    this.answers.set(i, values.map((v) => options[Number(v)]!.label).join(', '));
    this.check();
  }

  // A typed answer, for every question not answered yet
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
