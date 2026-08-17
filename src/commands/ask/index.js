import {SlashCommandBuilder} from 'discord.js'


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
    //reply() 需要字串或帶 content 的物件。原本傳 {question} 不含 content，
    //Discord 會回 50006 Cannot send an empty message，而且必定發生(ISSUES.md 的 C-01)。
    //question 是 setRequired(true)，不可能為 null，所以不需要另一條分支。
    await ctx.reply({content: question});
}
