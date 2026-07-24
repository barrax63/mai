import { InteractionResponseType } from 'discord-interactions';

/**
 * Minimal example command. Serves as the template for new commands.
 */
export const ping = {
  definition: {
    name: 'ping',
    description: 'Check whether the bot is alive',
    type: 1, // CHAT_INPUT
  },

  /**
   * @param {object} interaction Raw interaction payload from Discord.
   * @returns {object} Interaction response body.
   */
  execute(interaction) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `Pong! (interaction ${interaction.id})`,
      },
    };
  },
};
