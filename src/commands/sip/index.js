import {SlashCommandBuilder} from 'discord.js'


export const command = new SlashCommandBuilder()
.setName('sip')
.setDescription('sip command')


export const action = async(ctx) => {
    await ctx.reply('sip sip')
}
