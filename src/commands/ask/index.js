import {ActionRow, ActionRowBuilder, Component, SlashCommandBuilder} from 'discord.js'


export const command = new SlashCommandBuilder()
.setName('ask')
.setDescription('ask command')
.addStringOption(option =>
    option
    .setName('question')
    .setDescription('Question String')
    .setRequired(true)
)


export const action = async(ctx) => {
    const question = ctx.options.getString('question');
    const row = new ActionRowBuilder();
    if(question != null){
        await ctx.reply({question});
    }
    else{
        await ctx.reply('來搞的吧?!');
    }
}
