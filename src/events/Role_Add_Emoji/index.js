import {Client, Events } from 'discord.js'

export const event = {
    name :  Events.MessageReactionAdd
}

export const action = async(reaction, user) => {
    try{
        if(user.bot)    return;
        if(!reaction.message.guild) return;
        if(reaction.message.channelId === process.env.RoleChannel_ID){
            const emoji = reaction.emoji.name;
            const guildMember = reaction.message.guild.members.cache.get(user.id);
            switch(emoji){
                case '🇻':{
                    const role = reaction.message.guild.roles.cache.get('893355176243638333');
                    guildMember.roles.add(role);
                    break;
                }
                case '🐉':{
                    const role = reaction.message.guild.roles.cache.get('893136118126641152');
                    guildMember.roles.add(role);
                    break;
                }
                case '🍻':{
                    const role = reaction.message.guild.roles.cache.get('893325980788195440');
                    guildMember.roles.add(role);
                    break;
                }
                case '📱':{
                    const role = reaction.message.guild.roles.cache.get('893357345508302918');
                    guildMember.roles.add(role);
                    break;
                }
                case '💻':{
                    const role = reaction.message.guild.roles.cache.get('853333171440582657');
                    guildMember.roles.add(role);
                    break;
                }
                case '🏐':{
                    const role = reaction.message.guild.roles.cache.get('976854426025353267');
                    guildMember.roles.add(role);
                    break;
                }
                case 'Minecraft':{
                    const role = reaction.message.guild.roles.cache.get('991202365166325923');
                    guildMember.roles.add(role);
                    break;
                }
                case '🇱':{
                    const role = reaction.message.guild.roles.cache.get('1054357626550501416');
                    guildMember.roles.add(role);
                    break;
                }
                default:{
                    break;
                }
                
            }
        }
    }
    catch(e){
        //傳送錯誤訊息到管理員群組
        reaction.message.guild.channels.cache.get(process.env.AdminChannel_ID).send('Catch the error when Role_add by emoji : ' + e);
    }
}    
