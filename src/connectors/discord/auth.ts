import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Interaction,
  type Message,
  type MessageEditOptions,
} from 'discord.js';
import type { Clod } from '../../clod';

const CODE_BUTTON = 'claude-auth:code';
const CODE_MODAL = 'claude-auth:modal';
const CODE_INPUT = 'code';

// Fits both send and edit
interface Prompt {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

function prompt(url: string): Prompt {
  // Discord's limit for link button URLs
  const MAX_URL = 512;
  const content = 'Claude is not authenticated. Log in, then enter the code the page shows.';
  const code = new ButtonBuilder().setCustomId(CODE_BUTTON).setLabel('Enter code').setStyle(ButtonStyle.Primary);
  if (url.length > MAX_URL) {
    return { content: `${content}\n${url}`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(code)] };
  }
  const link = new ButtonBuilder().setURL(url).setLabel('Log in').setStyle(ButtonStyle.Link);
  return { content, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(link, code)] };
}

// DMed to every admin. Clod owns the login; this only shows it and passes
// the code an admin enters back to it.
export class Logins {
  private messages: Message[] = [];
  private login: Extract<Clod.Event, { type: 'login-required' }> | undefined;

  constructor(
    private readonly client: Client,
    private readonly admins: readonly string[],
  ) {
    client.on(Events.InteractionCreate, (interaction) => {
      this.handle(interaction).catch((e) => console.error('login interaction failed:', e));
    });
  }

  async required(login: Extract<Clod.Event, { type: 'login-required' }>) {
    this.login = login;
    if (this.messages.length > 0) {
      await this.edit(prompt(login.url));
      return;
    }
    if (this.admins.length === 0) console.error('no admin-id configured, nobody to DM the login to');
    for (const id of this.admins) {
      try {
        const user = await this.client.users.fetch(id);
        this.messages.push(await user.send(prompt(login.url)));
      } catch (e) {
        console.error(`failed to message admin ${id}:`, e);
      }
    }
  }

  async done(by: string) {
    this.login = undefined;
    await this.edit({ content: `Claude was authenticated by ${by}.`, components: [] });
    this.messages = [];
  }

  private async edit(options: MessageEditOptions) {
    await Promise.all(this.messages.map((m) => m.edit(options).catch((e) => console.error('failed to edit login message:', e))));
  }

  private async handle(interaction: Interaction) {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    if (interaction.customId !== CODE_BUTTON && interaction.customId !== CODE_MODAL) return;
    // Another instance of the bot may have sent this one, so leave it to that
    // instance. A button from a previous run goes unanswered too.
    if (!this.messages.some((m) => m.id === interaction.message?.id)) return;
    if (!this.admins.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Only admins can log Claude in.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.isButton()) {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(CODE_MODAL)
          .setTitle('Claude login')
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('Code')
              .setTextInputComponent(new TextInputBuilder().setCustomId(CODE_INPUT).setStyle(TextInputStyle.Short).setRequired(true)),
          ),
      );
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const login = this.login;
    if (!login) {
      await interaction.editReply('Claude is already authenticated.');
      return;
    }
    const ok = await login.submit(interaction.fields.getTextInputValue(CODE_INPUT), interaction.user.tag);
    await interaction.editReply(ok ? 'Authenticated.' : "That code didn't work. The message has a new login link now.");
  }
}
