import {SlashCommandBuilder} from 'discord.js'


export const command = new SlashCommandBuilder()
.setName('test')
.setDescription('test command')


export const action = async(ctx) => {
    await ctx.reply('test test')
}
