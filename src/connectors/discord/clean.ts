import type { Collection, GuildTextBasedChannel, Message } from 'discord.js';

// Deletes every message in the channel, newest first: those under 14 days old
// in bulk, older ones one at a time, as Discord allows. Stops when a round
// deletes nothing, so messages that can't be deleted don't loop forever.
// Resolves with how many messages were deleted and how many were left.
// The message with id keep, like the command's own reply, is left alone.
export async function clean(channel: GuildTextBasedChannel, keep?: string): Promise<{ deleted: number; left: number }> {
  let deleted = 0;
  for (;;) {
    const fetched: Collection<string, Message> = await channel.messages.fetch({ limit: 100 });
    const page = fetched.filter((message) => message.id !== keep);
    if (page.size === 0) return { deleted, left: 0 };
    const bulk = await channel.bulkDelete(page, true);
    let round = bulk.size;
    for (const message of page.values()) {
      if (bulk.has(message.id)) continue;
      if (await message.delete().then(() => true, () => false)) round++;
    }
    deleted += round;
    if (round === 0) return { deleted, left: page.size };
  }
}
