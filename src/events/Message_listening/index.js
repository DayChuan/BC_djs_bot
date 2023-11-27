import {Events, GatewayIntentBits } from 'discord.js'

export const event = {
    name : Events.MessageCreate
}

export const action = async(message) => {
    // console.log(message.author.bot);
    //如果訊息是機器人，則不進行任何動作
    if(message.author.bot) return;

    if(message.content.includes('sip')){
        message.channel.send('sip sip');
    }

    if(message.content.includes('確') ){
        message.channel.send(':thinking:');
    }

    if(message.content === '?'){
        message.channel.send('甚麼意思');
    }
}